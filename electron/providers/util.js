const crypto = require('node:crypto');

const DEFAULT_TIMEOUT = 20000;

// 在 Electron 中使用 net.fetch（走 Chromium 网络栈，自动使用系统代理/设置中的代理）；
// 在纯 Node（冒烟测试）中回退到全局 fetch（可用 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY 走代理）
let electronNet = null;
try {
  const e = require('electron');
  if (e && typeof e === 'object' && e.net) electronNet = e.net;
} catch {
  /* 非 Electron 环境 */
}
const doFetch = (url, opts) => (electronNet ? electronNet.fetch(url, opts) : fetch(url, opts));

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

// ---- 按上游域名限速：保护 API Key 配额，避免被上游封禁 ----
const HOST_INTERVAL_MS = Number(process.env.UPSTREAM_MIN_INTERVAL_MS) || 220; // 约 4.5 次/秒
const HOST_MAX_QUEUE = Number(process.env.UPSTREAM_MAX_QUEUE) || 60;
const hostState = new Map(); // host -> { next: 时间戳, queued: 数量 }

class BusyError extends Error {}

async function throttle(host) {
  let st = hostState.get(host);
  if (!st) hostState.set(host, (st = { next: 0, queued: 0 }));
  if (st.queued >= HOST_MAX_QUEUE) throw new BusyError('服务繁忙，请稍后再试');
  const now = Date.now();
  const at = Math.max(now, st.next);
  st.next = at + HOST_INTERVAL_MS;
  if (at > now) {
    st.queued++;
    try {
      await new Promise((r) => setTimeout(r, at - now));
    } finally {
      st.queued--;
    }
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

async function readText(res) {
  const len = Number(res.headers.get('content-length'));
  if (len && len > MAX_RESPONSE_BYTES) throw new Error('上游返回数据过大');
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('上游返回数据过大');
  return text;
}

async function getJSON(url, { headers = {}, timeout = DEFAULT_TIMEOUT } = {}) {
  const host = new URL(url).host;
  await throttle(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await doFetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
      redirect: 'error',
    });
    const text = await readText(res);
    if (!res.ok) {
      if (res.status === 429) throw new Error('上游接口请求过于频繁，请稍后再试');
      const m = upstreamMessage(text);
      throw new Error(`上游接口错误 (${host}, HTTP ${res.status})${m ? ': ' + m : ''}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`上游接口返回格式错误 (${host})`);
    }
  } catch (err) {
    if (err instanceof BusyError) throw err;
    if (err.name === 'AbortError') throw new Error(`请求超时: ${new URL(url).host}（如需代理，请在「设置」中配置）`);
    if (err instanceof TypeError || /ERR_|fetch failed/i.test(err.message)) {
      throw new Error(`网络连接失败: ${new URL(url).host}（如需代理，请在「设置」中配置）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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

module.exports = { getJSON, formatUnits, tronHexToBase58, BusyError };
