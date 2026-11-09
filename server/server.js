'use strict';
// OnLedger 网页版后端：仅使用 Node 内置模块。
// 提供 /api/chains、/api/ledger、/healthz 以及 dist/ 静态文件（SPA）。
// 部署于 Caddy 之后（Caddy 负责 TLS 与压缩），容器端口只发布在 127.0.0.1。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const { CHAINS } = require('../electron/chains');
const { queryLedger, normalizeRequest, InputError } = require('../electron/providers');
const { BusyError } = require('../electron/providers/util');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

const PORT = intEnv('PORT', 8080, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'));

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => normalizeOrigin(s.trim()))
    .filter(Boolean)
);

// API Key 只从环境变量读取；读取后从 process.env 删除，避免被子进程或调试输出意外带出
const SETTINGS = Object.freeze({
  etherscanApiKey: (process.env.ETHERSCAN_API_KEY || '').trim(),
  tronApiKey: (process.env.TRON_API_KEY || '').trim(),
});
delete process.env.ETHERSCAN_API_KEY;
delete process.env.TRON_API_KEY;
const SECRETS = [SETTINGS.etherscanApiKey, SETTINGS.tronApiKey].filter((s) => s.length >= 4);

const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_INFLIGHT_LEDGER = intEnv('MAX_INFLIGHT', 32, 1, 1024);
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 500;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const CACHE_MAX_ENTRY_BYTES = 1024 * 1024;
const BUCKETS_MAX = 50_000;
const SHUTDOWN_GRACE_MS = 8_000;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = [
  [
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
      "frame-ancestors 'none'",
  ],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  [
    'Permissions-Policy',
    'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), ' +
      'geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), ' +
      'picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=(), xr-spatial-tracking=()',
  ],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Strict-Transport-Security', 'max-age=31536000'],
  ['X-DNS-Prefetch-Control', 'off'],
  ['Origin-Agent-Cluster', '?1'],
];

// 去掉控制字符，防止日志注入
const clean = (s, max) => String(s).replace(/[\x00-\x1f\x7f]/g, '?').slice(0, max);

// 错误信息兜底脱敏：任何情况下都不回显 API Key
function scrub(msg) {
  let s = typeof msg === 'string' ? msg : '';
  for (const k of SECRETS) s = s.split(k).join('***');
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

function log(line) {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers || {};
  }
}

function sendJson(res, status, obj, extraHeaders) {
  if (res.headersSent || res.destroyed) return;
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

const sendError = (res, status, error, extra) => sendJson(res, status, { ok: false, error }, extra);

function sendText(res, status, text, extraHeaders) {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(res.req.method === 'HEAD' ? undefined : text);
}

// ---------------------------------------------------------------------------
// 客户端 IP / 同源校验
// ---------------------------------------------------------------------------
function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  ip = ip.trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (m) ip = m[1];
  return net.isIP(ip) ? ip : '';
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) {
      // 取最右侧一项：由紧邻的可信代理（Caddy）追加，客户端无法伪造
      const parts = xff.split(',');
      const ip = normalizeIp(parts[parts.length - 1]);
      if (ip) return ip;
    }
  }
  return normalizeIp(req.socket.remoteAddress) || 'unknown';
}

// IPv6 按 /64 聚合限流（单个用户通常拥有整个 /64）
function rateKey(ip) {
  if (!net.isIPv6(ip)) return ip;
  let a = ip.split('%')[0].toLowerCase();
  if (a.includes('.')) {
    const i = a.lastIndexOf(':');
    const v4 = a.slice(i + 1).split('.').map(Number);
    a = a.slice(0, i + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [head, tail] = a.split('::');
  const hp = head ? head.split(':') : [];
  let parts = hp;
  if (tail !== undefined) {
    const tp = tail ? tail.split(':') : [];
    parts = [...hp, ...new Array(Math.max(0, 8 - hp.length - tp.length)).fill('0'), ...tp];
  }
  return parts.slice(0, 4).map((p) => parseInt(p || '0', 16).toString(16)).join(':') + '::/64';
}

function lastHeaderValue(v) {
  if (typeof v !== 'string' || !v) return '';
  const parts = v.split(',');
  return parts[parts.length - 1].trim();
}

function normalizeOrigin(o) {
  if (typeof o !== 'string' || !o) return '';
  let u;
  try {
    u = new URL(o);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.origin.toLowerCase(); // URL.origin 会去掉默认端口
}

function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true; // 非浏览器客户端 / 同源 GET 可能不带 Origin
  const o = normalizeOrigin(origin);
  if (!o) return false; // 包括 "null"
  if (ALLOWED_ORIGINS.has(o)) return true;

  let proto = 'http';
  if (TRUST_PROXY) {
    const p = lastHeaderValue(req.headers['x-forwarded-proto']).toLowerCase();
    if (p === 'http' || p === 'https') proto = p;
  }
  const hosts = [req.headers.host];
  if (TRUST_PROXY) hosts.push(lastHeaderValue(req.headers['x-forwarded-host']));
  for (const h of hosts) {
    if (typeof h !== 'string' || !h || /[\s/@\\]/.test(h)) continue;
    if (normalizeOrigin(`${proto}://${h}`) === o) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 令牌桶限流（内存）
// ---------------------------------------------------------------------------
class RateLimiter {
  constructor({ perMinute, burst, maxKeys }) {
    this.rate = perMinute / 60_000; // 每毫秒补充的令牌数
    this.burst = burst;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  // 返回 0 表示放行，否则返回需等待的秒数
  take(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.burst, b.tokens + (now - b.ts) * this.rate);
      b.ts = now;
      this.buckets.delete(key); // 重新插入，保持近似 LRU 顺序
    } else {
      b = { tokens: this.burst, ts: now };
      while (this.buckets.size >= this.maxKeys) {
        this.buckets.delete(this.buckets.keys().next().value); // 容量上限：淘汰最久未访问的
      }
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.rate / 1000));
  }

  // 已完全补满的桶等同于新桶，可以删除
  sweep() {
    const now = Date.now();
    const fullAfter = this.burst / this.rate;
    for (const [k, b] of this.buckets) if (now - b.ts >= fullAfter) this.buckets.delete(k);
  }
}

const ledgerLimiter = new RateLimiter({
  perMinute: intEnv('LEDGER_RATE_PER_MIN', 60, 1, 100_000),
  burst: intEnv('LEDGER_RATE_BURST', 20, 1, 100_000),
  maxKeys: BUCKETS_MAX,
});
const generalLimiter = new RateLimiter({
  perMinute: intEnv('GENERAL_RATE_PER_MIN', 300, 1, 100_000),
  burst: intEnv('GENERAL_RATE_BURST', 100, 1, 100_000),
  maxKeys: BUCKETS_MAX,
});

// ---------------------------------------------------------------------------
// 账单查询：缓存 + 并发合并 + 全局并发上限
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> { body, exp, size }
let cacheBytes = 0;
const inflight = new Map(); // key -> Promise<body>
let activeUpstream = 0;

function cacheKey({ chain, token, address, cursor }) {
  // 仅 EVM（十六进制）大小写不敏感；TRON/BTC 的 base58 地址区分大小写，不能统一小写，否则会造成缓存投毒
  const ci = chain.type === 'evm';
  const tok = token.contract ? 'c:' + (ci ? token.contract.toLowerCase() : token.contract) : 's:' + token.symbol;
  return JSON.stringify([chain.id, tok, ci ? address.toLowerCase() : address, cursor || '']);
}

function cacheDelete(key) {
  const e = cache.get(key);
  if (e) {
    cacheBytes -= e.size;
    cache.delete(key);
  }
}

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.exp <= Date.now()) {
    cacheDelete(key);
    return null;
  }
  return e.body;
}

function cacheSet(key, body) {
  const size = Buffer.byteLength(body);
  if (size > CACHE_MAX_ENTRY_BYTES) return;
  cacheDelete(key);
  cache.set(key, { body, size, exp: Date.now() + CACHE_TTL_MS });
  cacheBytes += size;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    cacheDelete(cache.keys().next().value);
  }
}

function cacheSweep() {
  const now = Date.now();
  for (const [k, e] of cache) if (e.exp <= now) cacheDelete(k);
}

async function getLedger(raw) {
  const norm = normalizeRequest(raw); // 非法输入在这里抛 InputError
  const key = cacheKey(norm);
  const hit = cacheGet(key);
  if (hit) return { body: hit, cache: 'HIT' };
  if (norm.chain.type === 'evm' && !SETTINGS.etherscanApiKey) {
    throw new HttpError(503, '本站未配置 Etherscan API Key，暂不支持 EVM 链查询');
  }

  let p = inflight.get(key);
  if (p) return { body: await p, cache: 'SHARED' }; // 相同查询正在进行，共享同一次上游调用
  if (activeUpstream >= MAX_INFLIGHT_LEDGER) {
    throw new HttpError(503, '服务繁忙，请稍后再试', { 'Retry-After': '5' });
  }
  activeUpstream++;
  // 先异步化再调用，保证 finally 一定在 inflight.set 之后执行
  p = Promise.resolve()
    .then(() => queryLedger(raw, SETTINGS))
    .then((data) => {
      const body = JSON.stringify({ ok: true, data });
      // 余额查询失败属于部分错误，不缓存，避免把临时错误扩散给后续请求
      if (!data.balanceError) cacheSet(key, body);
      return body;
    })
    .finally(() => {
      activeUpstream--;
      inflight.delete(key);
    });
  inflight.set(key, p);
  return { body: await p, cache: 'MISS' };
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------
function readBody(req, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cl = req.headers['content-length'];
    if (cl !== undefined) {
      if (!/^\d{1,10}$/.test(cl)) return reject(new HttpError(400, '请求格式不正确'));
      if (Number(cl) > limit) return reject(new HttpError(413, '请求内容过大'));
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (c) => {
      size += c.length;
      if (size > limit) return finish(new HttpError(413, '请求内容过大'));
      chunks.push(c);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, size));
    const onError = () => finish(new HttpError(400, '请求读取失败'));
    const onClose = () => finish(new HttpError(400, '请求读取失败'));
    const timer = setTimeout(() => finish(new HttpError(408, '请求超时')), timeoutMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// 在请求体未读完时提前响应：告知关闭连接，丢弃剩余数据，并在短时间后强制断开
function closeAfterResponse(req, res) {
  if (!res.headersSent) res.setHeader('Connection', 'close');
  if (!req.complete) {
    req.resume();
    setTimeout(() => req.socket.destroy(), 2000).unref();
  }
}

// ---------------------------------------------------------------------------
// API 路由
// ---------------------------------------------------------------------------
const CHAINS_BODY = JSON.stringify({ ok: true, data: CHAINS });

async function handleLedger(req, res, ip) {
  if (req.method !== 'POST') {
    closeAfterResponse(req, res);
    return sendError(res, 405, '不支持的请求方法', { Allow: 'POST' });
  }
  const wait = ledgerLimiter.take(rateKey(ip));
  if (wait) {
    closeAfterResponse(req, res);
    return sendError(res, 429, '请求过于频繁，请稍后再试', { 'Retry-After': String(wait) });
  }
  if (!isSameOrigin(req)) {
    closeAfterResponse(req, res);
    return sendError(res, 403, '禁止跨站请求');
  }
  const ct = String(req.headers['content-type'] || '').split(';');
  const mediaType = ct[0].trim().toLowerCase();
  const params = ct.slice(1).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const badCharset = params.some((p) => p.startsWith('charset=') && !/^charset="?utf-8"?$/.test(p));
  const enc = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (mediaType !== 'application/json' || badCharset || enc !== 'identity') {
    closeAfterResponse(req, res);
    return sendError(res, 415, '请求类型必须为 application/json');
  }

  let raw;
  try {
    const buf = await readBody(req, MAX_BODY_BYTES, BODY_TIMEOUT_MS);
    raw = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e instanceof HttpError) {
      closeAfterResponse(req, res);
      return sendError(res, e.status, e.message);
    }
    return sendError(res, 400, '请求格式不正确（JSON 无效）');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return sendError(res, 400, '请求参数不正确');
  }

  // 只挑出需要的字段，丢弃其余内容
  const tok = raw.token;
  const picked = {
    chainId: raw.chainId,
    token:
      tok && typeof tok === 'object' && !Array.isArray(tok)
        ? tok.contract != null
          ? { contract: tok.contract }
          : { symbol: tok.symbol }
        : tok,
    address: raw.address,
    cursor: raw.cursor,
  };

  try {
    const { body, cache: cacheStatus } = await getLedger(picked);
    res.setHeader('X-Cache', cacheStatus);
    return sendJson(res, 200, body);
  } catch (e) {
    if (e instanceof InputError) return sendError(res, 400, scrub(e.message).slice(0, 200) || '请求参数不正确');
    if (e instanceof HttpError) return sendError(res, e.status, e.message, e.headers);
    if (e instanceof BusyError) return sendError(res, 503, '服务繁忙，请稍后再试', { 'Retry-After': '5' });
    // 网页版没有「设置」界面，去掉桌面端的相关提示
    const m = e instanceof Error ? scrub(e.message).replace(/[（(][^（()）]*「设置」[^（()）]*[）)]/g, '').trim() : '';
    const msg = m.slice(0, 200) || '上游服务错误，请稍后再试';
    log(`upstream-error ${clean(msg, 200)}`);
    return sendError(res, 502, msg);
  }
}

function handleApi(req, res, pathname, ip) {
  if (pathname === '/api/ledger') return handleLedger(req, res, ip);
  if (pathname === '/api/chains') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      closeAfterResponse(req, res);
      return sendError(res, 405, '不支持的请求方法', { Allow: 'GET, HEAD' });
    }
    return sendJson(res, 200, CHAINS_BODY);
  }
  closeAfterResponse(req, res);
  return sendError(res, 404, '接口不存在');
}

// ---------------------------------------------------------------------------
// 静态文件：启动时建立白名单索引（不跟随符号链接、不含隐藏文件），请求只在索引中查找
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};
const MAX_INMEMORY_FILE = 4 * 1024 * 1024;

const staticFiles = new Map(); // URL 路径 -> { abs, size, type, etag, data? }
let staticRoot = null;

function buildStaticIndex() {
  try {
    staticRoot = fs.realpathSync(STATIC_DIR);
    if (!fs.statSync(staticRoot).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    staticRoot = null;
    log(`warn static dir unavailable: ${clean(STATIC_DIR, 300)} (${clean(e.code || e.message, 100)})`);
    return;
  }
  const walk = (dir, urlPrefix, depth) => {
    if (depth > 16) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = ent.name;
      if (name.startsWith('.') || /[\x00-\x1f\\%]/.test(name)) continue; // 不提供隐藏文件
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue; // 不跟随符号链接
      const rel = path.relative(staticRoot, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const urlPath = urlPrefix + '/' + name;
      if (st.isDirectory()) walk(abs, urlPath, depth + 1);
      else if (st.isFile()) {
        const ext = path.extname(name).toLowerCase();
        const entry = {
          abs,
          size: st.size,
          type: MIME[ext] || 'application/octet-stream',
          etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
          data: st.size <= MAX_INMEMORY_FILE ? fs.readFileSync(abs) : null,
        };
        if (entry.data) entry.size = entry.data.length;
        staticFiles.set(urlPath, entry);
      }
    }
  };
  walk(staticRoot, '', 0);
  if (!staticFiles.has('/index.html')) log('warn index.html not found in static dir');
}

// 安全解码 URL 路径；可疑路径返回 null
function safeDecodePath(rawPath) {
  if (rawPath.includes('\\') || /%5c/i.test(rawPath) || /%00/.test(rawPath)) return null;
  let p;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (!p.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(p) || p.includes('//')) return null;
  // 任何以 "." 开头的路径段（包括 . 和 ..、隐藏文件）一律拒绝
  if (p.split('/').some((seg) => seg.startsWith('.'))) return null;
  if (/^\/[a-zA-Z]:/.test(p)) return null;
  return p;
}

function serveEntry(req, res, entry, cacheControl) {
  res.setHeader('Content-Type', entry.type);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', entry.etag);
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === entry.etag)) {
    res.statusCode = 304;
    return res.end();
  }
  res.statusCode = 200;
  res.setHeader('Content-Length', entry.size);
  if (req.method === 'HEAD') return res.end();
  if (entry.data) return res.end(entry.data);
  const stream = fs.createReadStream(entry.abs);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function handleStatic(req, res, rawPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    closeAfterResponse(req, res);
    return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }
  const p = safeDecodePath(rawPath);
  if (p === null) return sendText(res, 400, 'Bad Request');

  const index = staticFiles.get('/index.html');
  if (p === '/' || p === '/index.html') {
    return index ? serveEntry(req, res, index, 'no-cache') : sendText(res, 404, 'Not Found');
  }
  const entry = staticFiles.get(p);
  if (entry) {
    const cc = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return serveEntry(req, res, entry, cc);
  }
  // 看起来像文件（有扩展名）或位于 /assets 下的缺失资源 -> 404；其余路径交给前端（SPA）
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (p.startsWith('/assets/') || last.includes('.') || !index) return sendText(res, 404, 'Not Found');
  return serveEntry(req, res, index, 'no-cache');
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
let shuttingDown = false;

async function handle(req, res) {
  const start = process.hrtime.bigint();
  for (const [k, v] of SECURITY_HEADERS) res.setHeader(k, v);
  if (shuttingDown) res.setHeader('Connection', 'close');

  const url = req.url || '';
  const qi = url.search(/[?#]/);
  const rawPath = qi === -1 ? url : url.slice(0, qi);
  const ip = clientIp(req);

  if (rawPath !== '/healthz') {
    res.on('close', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.writableFinished ? res.statusCode : `${res.statusCode}-aborted`;
      log(`${ip} ${clean(req.method, 10)} ${clean(rawPath, 200)} ${status} ${ms.toFixed(1)}ms`);
    });
  }

  if (url.length > MAX_URL_LENGTH) {
    closeAfterResponse(req, res);
    return sendText(res, 414, 'URI Too Long');
  }
  if (!rawPath.startsWith('/')) {
    closeAfterResponse(req, res);
    return sendText(res, 400, 'Bad Request');
  }

  if (rawPath === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      closeAfterResponse(req, res);
      return sendText(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }
    return sendText(res, 200, 'ok');
  }

  const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
  if (!(isApi && rawPath === '/api/ledger')) {
    const wait = generalLimiter.take(rateKey(ip));
    if (wait) {
      closeAfterResponse(req, res);
      const h = { 'Retry-After': String(wait) };
      return isApi ? sendError(res, 429, '请求过于频繁，请稍后再试', h) : sendText(res, 429, 'Too Many Requests', h);
    }
  }

  if (isApi) return handleApi(req, res, rawPath, ip);
  return handleStatic(req, res, rawPath);
}

const server = http.createServer(
  {
    requestTimeout: 30_000, // 接收完整请求的最长时间
    headersTimeout: 20_000,
    keepAliveTimeout: 65_000,
    maxHeaderSize: 16 * 1024,
    requireHostHeader: true,
    joinDuplicateHeaders: false,
  },
  (req, res) => {
    handle(req, res).catch((e) => {
      log(`error ${clean(scrub(e && e.stack ? e.stack : String(e)), 1000)}`);
      if (!res.headersSent) sendError(res, 500, '服务器内部错误');
      else res.destroy();
    });
  }
);
server.maxHeadersCount = 64;
server.maxRequestsPerSocket = 1000;
server.timeout = 120_000; // 套接字空闲超时（上游最慢情况下也够用）
server.maxConnections = intEnv('MAX_CONNECTIONS', 2048, 16, 100_000);

server.on('clientError', (err, socket) => {
  if (!socket.writable || socket.destroyed) return socket.destroy();
  const code = err && err.code;
  const status =
    code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
    : code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout'
    : code === 'HPE_URI_TOO_LONG' ? '414 URI Too Long'
    : '400 Bad Request';
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
});

const sweeper = setInterval(() => {
  ledgerLimiter.sweep();
  generalLimiter.sweep();
  cacheSweep();
}, 60_000);
sweeper.unref();

function shutdown(signal) {
  if (shuttingDown) {
    log(`${signal} received again, exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  clearInterval(sweeper);
  server.close(() => {
    log('server closed');
    process.exit(0);
  });
  // 进行中的请求完成后，连接变为空闲即关闭（不等 keep-alive 超时）
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 250).unref();
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(0);
  }, SHUTDOWN_GRACE_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection ${clean(scrub(reason instanceof Error ? reason.stack || reason.message : String(reason)), 1000)}`);
});
process.on('uncaughtException', (err) => {
  log(`uncaughtException ${clean(scrub(err && err.stack ? err.stack : String(err)), 1000)}`);
  process.exit(1); // 状态可能已损坏，退出后由容器重启
});

buildStaticIndex();
server.listen(PORT, HOST, () => {
  log(
    `OnLedger web server listening on ${HOST}:${PORT} ` +
      `(static: ${staticRoot ? staticFiles.size + ' files' : 'disabled'}, trustProxy: ${TRUST_PROXY}, ` +
      `etherscanKey: ${SETTINGS.etherscanApiKey ? 'set' : 'unset'}, tronKey: ${SETTINGS.tronApiKey ? 'set' : 'unset'})`
  );
});
