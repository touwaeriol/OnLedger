// 地址校验和验证（仅使用 Node 内置模块）
//   tron: Base58Check，21 字节载荷且以 0x41 开头
//   btc : Base58Check P2PKH(0x00) / P2SH(0x05)；SegWit bech32 (BIP-173, v0) / bech32m (BIP-350, v1-v16)，仅主网 bc
//   evm : 0x + 40 位十六进制；大小写混合时校验 EIP-55（keccak-256）
// 所有函数对任意输入安全：非字符串或超长输入直接返回 false，处理时间与长度线性相关。

const crypto = require('crypto');

const MAX_LEN = 100;

// ---------- Base58Check ----------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

/** Base58 解码；非法字符返回 null。调用方需先限制长度（算法为 O(n²)）。 */
function base58Decode(s) {
  const bytes = []; // 小端
  for (const ch of s) {
    let carry = B58_MAP.get(ch);
    if (carry === undefined) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

/** Base58Check 解码，返回去掉校验和的载荷；格式或校验和错误返回 null。 */
function base58CheckDecode(s) {
  const raw = base58Decode(s);
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return checksum.equals(raw.subarray(raw.length - 4)) ? payload : null;
}

function isValidTron(addr) {
  if (addr.length !== 34 || addr[0] !== 'T') return false;
  const payload = base58CheckDecode(addr);
  return !!payload && payload.length === 21 && payload[0] === 0x41;
}

// ---------- Bech32 / Bech32m (BIP-173 / BIP-350) ----------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk >>> 0;
}

/** 解码 bech32/bech32m 字符串；返回 {hrp, data(不含校验和), spec} 或 null。 */
function bech32Decode(s) {
  if (s.length > 90) return null;
  let hasLower = false;
  let hasUpper = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 33 || c > 126) return null;
    if (c >= 97 && c <= 122) hasLower = true;
    else if (c >= 65 && c <= 90) hasUpper = true;
  }
  if (hasLower && hasUpper) return null;
  const str = s.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) return null;
  const hrp = str.slice(0, pos);
  const data = [];
  for (let i = pos + 1; i < str.length; i++) {
    const d = BECH32_CHARSET.indexOf(str[i]);
    if (d === -1) return null;
    data.push(d);
  }
  const expanded = [];
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) >> 5);
  expanded.push(0);
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) & 31);
  const pm = bech32Polymod(expanded.concat(data));
  const spec = pm === BECH32_CONST ? 'bech32' : pm === BECH32M_CONST ? 'bech32m' : null;
  if (!spec) return null;
  return { hrp, data: data.slice(0, -6), spec };
}

/** 5 位 → 8 位转换（不补位）：剩余位数 ≥5 或剩余位非零均视为非法。 */
function convert5to8(data) {
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data) {
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) return null;
  return out;
}

function isValidSegwit(addr) {
  const dec = bech32Decode(addr);
  if (!dec || dec.hrp !== 'bc' || dec.data.length < 1) return false;
  const version = dec.data[0];
  if (version > 16) return false;
  const program = convert5to8(dec.data.slice(1));
  if (!program || program.length < 2 || program.length > 40) return false;
  if (version === 0) {
    if (program.length !== 20 && program.length !== 32) return false;
    return dec.spec === 'bech32';
  }
  return dec.spec === 'bech32m';
}

function isValidBtc(addr) {
  if (/^bc1/i.test(addr)) return isValidSegwit(addr);
  if (addr.length < 26 || addr.length > 35) return false;
  const payload = base58CheckDecode(addr);
  return !!payload && payload.length === 21 && (payload[0] === 0x00 || payload[0] === 0x05);
}

// ---------- Keccak-256 / EIP-55 ----------

const MASK64 = (1n << 64n) - 1n;
const KECCAK_RC = [];
const KECCAK_ROT = [];
const KECCAK_PI = [];
{
  let R = 1n;
  for (let round = 0, x = 1, y = 0; round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    KECCAK_PI.push(x + 5 * y);
    KECCAK_ROT.push(BigInt((((round + 1) * (round + 2)) / 2) % 64));
    let rc = 0n;
    for (let j = 0; j < 7; j++) {
      R = ((R << 1n) ^ ((R >> 7n) * 0x71n)) % 256n;
      if (R & 2n) rc ^= 1n << ((1n << BigInt(j)) - 1n);
    }
    KECCAK_RC.push(rc);
  }
}

const rotl64 = (v, n) => (n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK64);

function keccakF(A) {
  const C = new Array(5);
  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D;
    }
    // ρ + π
    let cur = A[1];
    for (let t = 0; t < 24; t++) {
      const j = KECCAK_PI[t];
      const tmp = A[j];
      A[j] = rotl64(cur, KECCAK_ROT[t]);
      cur = tmp;
    }
    // χ
    for (let y = 0; y < 25; y += 5) {
      const b0 = A[y], b1 = A[y + 1], b2 = A[y + 2], b3 = A[y + 3], b4 = A[y + 4];
      A[y] = b0 ^ (~b1 & MASK64 & b2);
      A[y + 1] = b1 ^ (~b2 & MASK64 & b3);
      A[y + 2] = b2 ^ (~b3 & MASK64 & b4);
      A[y + 3] = b3 ^ (~b4 & MASK64 & b0);
      A[y + 4] = b4 ^ (~b0 & MASK64 & b1);
    }
    // ι
    A[0] ^= KECCAK_RC[round];
  }
}

/** 原版 Keccak-256（以太坊使用，填充 0x01，区别于 NIST SHA3-256 的 0x06）。返回 32 字节 Buffer。 */
function keccak256(input) {
  const msg = Buffer.from(input);
  const rate = 136;
  const padLen = rate - (msg.length % rate);
  const padded = Buffer.concat([msg, Buffer.alloc(padLen)]);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8);
  return out;
}

function isValidEvm(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const body = addr.slice(2);
  const lower = body.toLowerCase();
  if (body === lower || body === body.toUpperCase()) return true; // 无校验和信息
  const hash = keccak256(lower).toString('hex');
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (c >= '0' && c <= '9') continue;
    const upper = parseInt(hash[i], 16) >= 8;
    if (upper !== (c >= 'A' && c <= 'F')) return false;
  }
  return true;
}

// ---------- 入口 ----------

const VALIDATORS = { evm: isValidEvm, tron: isValidTron, btc: isValidBtc };

/**
 * @param {'evm'|'tron'|'btc'} chainType
 * @param {unknown} address
 * @returns {boolean}
 */
function isValidAddress(chainType, address) {
  if (typeof address !== 'string' || address.length === 0 || address.length > MAX_LEN) return false;
  const fn = Object.prototype.hasOwnProperty.call(VALIDATORS, chainType) ? VALIDATORS[chainType] : null;
  if (!fn) return false;
  try {
    return fn(address) === true;
  } catch {
    return false;
  }
}

module.exports = { isValidAddress, keccak256 };
