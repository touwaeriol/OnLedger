const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

function envInt(name, def, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

const DEFAULT_TIMEOUT = envInt('UPSTREAM_TIMEOUT_MS', 15000, 1000, 120000);
// 上游响应体上限：边读边计数，超过即中止（不依赖 Content-Length）
const MAX_RESPONSE_BYTES = envInt('UPSTREAM_MAX_RESPONSE_BYTES', 4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024);

// 在 Electron 中使用 net.fetch（走 Chromium 网络栈，自动使用系统代理/设置中的代理）；
// 在纯 Node（冒烟测试）中回退到全局 fetch（可用 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 走代理）
let electronNet = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.net) electronNet = e.net;
} catch {
  /* 非 Electron 环境 */
}
let fetchOverride = null; // 仅供测试注入，生产环境始终为 null
const doFetch = (url, opts) =>
  fetchOverride ? fetchOverride(url, opts) : electronNet ? electronNet.fetch(url, opts) : fetch(url, opts);

// ---- 按上游域名限速 + 并发上限 + 每日额度：保护 API Key 配额，避免被上游封禁 ----
const HOST_INTERVAL_MS = envInt('UPSTREAM_MIN_INTERVAL_MS', 220, 0, 60000); // 约 4.5 次/秒
const HOST_MAX_CONCURRENCY = envInt('UPSTREAM_MAX_CONCURRENCY', 0, 0, 256) || Infinity; // 每个域名同时进行的请求数，0 = 不限制（默认）
const HOST_MAX_QUEUE = envInt('UPSTREAM_MAX_QUEUE', 60, 0, 10000); // 每个域名排队等待的请求数
// 每日调用额度（UTC 0 点重置，仅内存计数；0 表示不限）
const DAILY_BUDGET = {
  'api.etherscan.io': envInt('DAILY_BUDGET_ETHERSCAN', 90000, 0, 1e9),
  'api.trongrid.io': envInt('DAILY_BUDGET_TRONGRID', 90000, 0, 1e9),
  'mempool.space': envInt('DAILY_BUDGET_MEMPOOL', 200000, 0, 1e9),
  'api.coingecko.com': envInt('DAILY_BUDGET_COINGECKO', 5000, 0, 1e9),
};
const DAY_MS = 86_400_000;
// 上游返回 429/503 时自动重试：最多 2 次，优先遵循 Retry-After（最多 5 秒），否则依次等待 1 秒、2 秒
const MAX_RETRIES = 2;
const RETRY_AFTER_CAP_MS = 5000;
const SLOWDOWN_MS = 30_000; // 收到 429 后该域名请求间隔加倍的持续时间
const hostState = new Map(); // host -> { next, active, waiters, day, used, slowUntil }

class BusyError extends Error {}

// 每日额度用完；retryAfter 为距 UTC 0 点的秒数（最多 3600）
class QuotaError extends BusyError {
  constructor() {
    super('今日查询额度已用完，请明天再试');
    const ms = (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS - Date.now();
    this.retryAfter = Math.min(3600, Math.max(1, Math.ceil(ms / 1000)));
  }
}

// 上游错误：transient=true 表示临时性错误（超时、网络、5xx、429、取消等），调用方不应缓存
function upstreamError(message, { transient, status, aborted } = {}) {
  const e = new Error(message);
  e.transient = !!transient;
  if (status) e.upstreamStatus = status;
  if (aborted) e.aborted = true;
  return e;
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

// 当前异步上下文中的取消信号：服务端在客户端断开时取消上游请求，无需改动各 provider 的参数传递
const signalStore = new AsyncLocalStorage();
const runWithSignal = (signal, fn) => signalStore.run(signal, fn);

function getHostState(host) {
  let st = hostState.get(host);
  if (!st) hostState.set(host, (st = { next: 0, active: 0, waiters: [], day: 0, used: 0, slowUntil: 0 }));
  return st;
}

function budgetLeft(st, host) {
  const limit = DAILY_BUDGET[host];
  if (!limit) return Infinity;
  const day = Math.floor(Date.now() / DAY_MS);
  if (st.day !== day) {
    st.day = day;
    st.used = 0;
  }
  return limit - st.used;
}

// 可被取消的等待
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// 取得某域名的一个并发名额并满足最小间隔，同时扣减每日额度；返回释放函数
async function acquire(host, signal) {
  if (signal.aborted) throw abortError();
  const st = getHostState(host);
  if (budgetLeft(st, host) <= 0) throw new QuotaError();
  if (st.active < HOST_MAX_CONCURRENCY && st.waiters.length === 0) {
    st.active++;
  } else {
    if (st.waiters.length >= HOST_MAX_QUEUE) throw new BusyError('服务繁忙，请稍后再试');
    // 排队等待名额；释放方直接把名额转交给队首（active 不变）
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        const i = st.waiters.indexOf(w);
        if (i !== -1) st.waiters.splice(i, 1);
        reject(abortError());
      };
      const w = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      st.waiters.push(w);
    });
  }
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    const next = st.waiters.shift();
    if (next) next();
    else st.active--;
  };
  try {
    const now = Date.now();
    const at = Math.max(now, st.next);
    st.next = at + (st.slowUntil > now ? HOST_INTERVAL_MS * 2 : HOST_INTERVAL_MS);
    if (at > now) await sleep(at - now, signal);
    if (budgetLeft(st, host) <= 0) throw new QuotaError();
    st.used++;
    return release;
  } catch (e) {
    release();
    throw e;
  }
}

// 只取上游错误里的简短说明，不回显原始响应体
function upstreamMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = j.error || j.message || j.result;
    if (typeof m === 'string') return m.replace(/[^ -~一-龥]/g, '').slice(0, 120);
  } catch {
    /* 非 JSON */
  }
  return '';
}

// 以流方式读取响应体，超过上限立即中止（Node 全局 fetch 与 Electron net.fetch 都返回 WHATWG Response）
async function readText(res, abort) {
  const tooLarge = () => upstreamError('上游返回数据过大');
  const len = Number(res.headers.get('content-length'));
  const body = res.body;
  if (len && len > MAX_RESPONSE_BYTES) {
    if (body) body.cancel().catch(() => {});
    abort();
    throw tooLarge();
  }
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      reader.cancel().catch(() => {});
      abort();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks, size));
}

// 解析 Retry-After（秒数或 HTTP 日期），最多 5 秒；没有时依次等待 1 秒、2 秒
function retryDelay(res, attempt) {
  const ra = String(res.headers.get('retry-after') || '').trim();
  if (ra) {
    const ms = /^\d+$/.test(ra) ? Number(ra) * 1000 : Date.parse(ra) - Date.now();
    if (Number.isFinite(ms)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, ms));
  }
  return 1000 * (attempt + 1);
}

/**
 * 请求并解析 JSON（默认 GET；传 body 对象时以 JSON 形式 POST）。
 * signal：外部取消信号（未传时使用 runWithSignal 设置的上下文信号），与超时合并；
 * 超时从排队开始计算（包括重试等待），首次排队期间超时视为繁忙（BusyError）。
 * 上游 429/503 时自动重试，每次重试同样经过限速、并发与每日额度控制。
 */
async function getJSON(url, { method, body, headers = {}, timeout = DEFAULT_TIMEOUT, signal } = {}) {
  const host = new URL(url).host;
  const m = String(method || (body !== undefined ? 'POST' : 'GET')).toUpperCase();
  if (m !== 'GET' && m !== 'POST') throw new Error(`不支持的请求方法: ${m}`);
  const init = { method: m, headers: { Accept: 'application/json', ...headers }, redirect: 'error' };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }

  const ext = signal || signalStore.getStore() || null;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onExtAbort = () => controller.abort();
  if (ext) {
    if (ext.aborted) controller.abort();
    else ext.addEventListener('abort', onExtAbort, { once: true });
  }
  let release = null;
  let phase = 'queue'; // queue | fetch | backoff
  let attempt = 0;
  try {
    for (;;) {
      phase = 'queue';
      release = await acquire(host, controller.signal);
      phase = 'fetch';
      const res = await doFetch(url, { ...init, signal: controller.signal });
      const text = await readText(res, () => controller.abort());
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw upstreamError(`上游接口返回格式错误 (${host})`, { transient: true });
        }
      }
      if (res.status === 429 || res.status === 503) {
        const st = getHostState(host);
        if (res.status === 429) {
          // 暂时放慢该域名：之后 30 秒内请求间隔加倍，并推迟下一个请求
          st.slowUntil = Date.now() + SLOWDOWN_MS;
          st.next = Math.max(st.next, Date.now() + HOST_INTERVAL_MS * 2);
        }
        if (attempt >= MAX_RETRIES) {
          throw upstreamError(`数据源繁忙（${host}），请稍等几秒后重试`, { transient: true, status: res.status });
        }
        const delay = retryDelay(res, attempt);
        attempt++;
        release(); // 等待期间不占用并发名额
        release = null;
        phase = 'backoff';
        await sleep(delay, controller.signal);
        continue;
      }
      const um = upstreamMessage(text);
      throw upstreamError(`上游接口错误 (${host}, HTTP ${res.status})${um ? ': ' + um : ''}`, {
        transient: res.status >= 500 || res.status === 408,
        status: res.status,
      });
    }
  } catch (err) {
    if (err instanceof BusyError) throw err;
    if (err && typeof err.transient === 'boolean') throw err; // 上面已分类的上游错误
    if (ext && ext.aborted && !timedOut) throw upstreamError('请求已取消', { transient: true, aborted: true });
    if (timedOut || (err && err.name === 'AbortError')) {
      if (phase !== 'fetch') {
        if (attempt === 0) throw new BusyError('服务繁忙，请稍后再试'); // 仍在本地排队
        throw upstreamError(`数据源繁忙（${host}），请稍等几秒后重试`, { transient: true });
      }
      throw upstreamError(`请求超时: ${host}（如需代理，请在「设置」中配置）`, { transient: true });
    }
    if (err instanceof TypeError || /ERR_|fetch failed/i.test(err && err.message)) {
      throw upstreamError(`网络连接失败: ${host}（如需代理，请在「设置」中配置）`, { transient: true });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (ext) ext.removeEventListener('abort', onExtAbort);
    if (release) release();
  }
}

// 整数字符串 + 精度 -> 十进制字符串（BigInt，避免浮点误差）
function formatUnits(raw, decimals) {
  const d = Math.min(Math.max(Math.trunc(Number(decimals)) || 0, 0), 255); // ERC-20/TRC-20 精度为 uint8
  let v = BigInt(raw || 0);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(d);
  const int = v / base;
  let frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + int.toString() + (frac ? '.' + frac : '');
}

// ---- TRON 地址 hex(41...) <-> base58 ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function base58Encode(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

function tronHexToBase58(hex) {
  if (!hex) return '';
  if (hex.startsWith('T')) return hex;
  let h = hex.replace(/^0x/, '');
  if (h.length === 40) h = '41' + h;
  const payload = Buffer.from(h, 'hex');
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

// ---- 仅供测试：注入假的 fetch、重置/查看域名状态。生产代码从不调用 ----
const __testing = {
  setFetch(fn) {
    fetchOverride = typeof fn === 'function' ? fn : null;
  },
  reset() {
    hostState.clear();
  },
  hostState(host) {
    const st = hostState.get(host);
    return st ? { active: st.active, queued: st.waiters.length, used: st.used, slowUntil: st.slowUntil } : null;
  },
  setUsed(host, used) {
    const st = getHostState(host);
    budgetLeft(st, host);
    st.used = used;
  },
};

module.exports = { getJSON, formatUnits, tronHexToBase58, BusyError, QuotaError, runWithSignal, __testing };
