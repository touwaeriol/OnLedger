// 地址校验和验证测试：node scripts/address-test.js
const assert = require('assert');
const { CHAINS } = require('../electron/chains');
const { isValidAddress, keccak256 } = require('../electron/providers/address');
const { normalizeRequest, InputError } = require('../electron/providers');

let passed = 0;
function ok(type, addr, label = '') {
  assert.strictEqual(isValidAddress(type, addr), true, `应有效 [${type}] ${label} ${addr}`);
  passed++;
}
function bad(type, addr, label = '') {
  const shown = typeof addr === 'string' ? addr.slice(0, 120) : typeof addr;
  assert.strictEqual(isValidAddress(type, addr), false, `应无效 [${String(type)}] ${label} ${shown}`);
  passed++;
}

// ---------- keccak-256 ----------
assert.strictEqual(keccak256('').toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
assert.strictEqual(keccak256('abc').toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
passed += 2;

// ---------- EVM ----------
const EIP55 = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
];
for (const a of EIP55) {
  ok('evm', a, 'EIP-55');
  ok('evm', '0x' + a.slice(2).toLowerCase(), '全小写');
  ok('evm', '0x' + a.slice(2).toUpperCase(), '全大写');
  // 翻转任意一个字母的大小写都必须被检测出
  for (let i = 2; i < a.length; i++) {
    const c = a[i];
    if (!/[a-fA-F]/.test(c)) continue;
    const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    bad('evm', a.slice(0, i) + flipped + a.slice(i + 1), 'EIP-55 大小写错误');
  }
}
bad('evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', 'EIP-55 末位大小写错误');
bad('evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe', '39 位');
bad('evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed0', '41 位');
bad('evm', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed00', '无 0x');
bad('evm', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg', '非十六进制');
bad('evm', '0X5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '大写 0X');
bad('evm', ' 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '前导空格');

// ---------- TRON ----------
const TRON_VALID = ['THHkUaA5vipYRJV33mFN856wunvL5G6hXm', 'TCGvM8LDb8pACZx8uD9hBhW6mconpAiXzS', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'];
for (const a of TRON_VALID) ok('tron', a, 'TRON');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function oneCharVariants(a, alphabet, from) {
  const out = [];
  for (let i = from; i < a.length; i++) {
    const idx = alphabet.indexOf(a[i]);
    assert.ok(idx >= 0);
    for (const d of [1, 7]) out.push(a.slice(0, i) + alphabet[(idx + d) % alphabet.length] + a.slice(i + 1));
  }
  return out;
}
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
for (const a of TRON_VALID) for (const v of oneCharVariants(a, B58, 1)) bad('tron', v, '单字符变化');
bad('tron', 'T111111111111111111111111111111111', '伪造');
bad('tron', 'TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '伪造');
bad('tron', 'THHkUaA5vipYRJV33mFN856wunvL5G6hX', '33 位');
bad('tron', 'THHkUaA5vipYRJV33mFN856wunvL5G6hXmm', '35 位');
bad('tron', 'THHkUaA5vipYRJV33mFN856wunvL5G6hX0', '非 base58 字符');
bad('tron', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'BTC 地址');
bad('tron', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'EVM 地址');

// ---------- BTC ----------
const BTC_VALID = [
  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
];
// BIP-350 有效 segwit 地址（主网部分）
const BIP350_VALID = [
  'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
  'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
  'BC1SW50QGDZ25J',
  'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
];
for (const a of [...BTC_VALID, ...BIP350_VALID]) ok('btc', a, 'BTC');

const BTC_INVALID = [
  // BIP-350 有效但非主网（仅支持主网）
  'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
  'tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy',
  'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
  // BIP-350 无效列表
  'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
  'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
  'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
  'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47',
  'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
  'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R',
  'bc1pw5dgrnzv',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav',
  'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P',
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf',
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j',
  'bc1gmk9yu',
  // BIP-173 无效列表
  'tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',
  'BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2',
  'bc1rw5uspcuh',
  'bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90',
  'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7',
  'bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du',
  'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv',
  // BIP-173 中 v1+ 使用 bech32 的旧编码，BIP-350 之后无效
  'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx',
  'BC1SW50QA3JX3S',
  'bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj',
  // 伪造 / 其他
  'bc1qqqqqqqqqqqq',
  'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  '1111111111111111111111111111111111',
  '3333333333333333333333333333333333',
  'bc1' + 'q'.repeat(88),
  'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlH', // 混合大小写
  'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', // 测试网 P2PKH
  '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', // 测试网 P2SH
  'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // TRON 地址（版本 0x41）
];
for (const a of BTC_INVALID) bad('btc', a, '无效向量');

for (const a of BTC_VALID) {
  const segwit = a.startsWith('bc1');
  for (const v of oneCharVariants(a, segwit ? BECH32 : B58, segwit ? 4 : 1)) bad('btc', v, '单字符变化');
}

// ---------- chains.js 中所有代币合约 ----------
let contracts = 0;
for (const chain of CHAINS) {
  for (const t of chain.tokens) {
    if (!t.contract) continue;
    ok(chain.type, t.contract, `${chain.id} ${t.symbol}`);
    assert.ok(new RegExp(chain.addressPattern).test(t.contract));
    contracts++;
  }
}
assert.strictEqual(contracts, 13);

// ---------- 任意输入安全 ----------
for (const type of ['evm', 'tron', 'btc', 'foo', '__proto__', 'constructor', undefined, null]) {
  for (const v of [undefined, null, 0, 1, true, {}, [], ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'], Symbol('x'), () => {}, '', ' ']) {
    bad(type, v, '非字符串/空');
  }
}
bad('foo', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '未知链类型');
bad('toString', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '原型属性');
const t0 = Date.now();
for (const type of ['evm', 'tron', 'btc']) {
  for (const huge of ['1'.repeat(1e6), 'bc1' + 'q'.repeat(1e6), '0x' + 'a'.repeat(1e6), 'T' + 'z'.repeat(1e6)]) bad(type, huge, '超长');
}
assert.ok(Date.now() - t0 < 500, '超长输入应快速返回');

// ---------- normalizeRequest 集成 ----------
function rejects(req, msg) {
  assert.throws(() => normalizeRequest(req), (e) => e instanceof InputError && e.message === msg);
  passed++;
}
rejects({ chainId: 'tron', address: 'T111111111111111111111111111111111', token: { symbol: 'TRX' } }, 'TRON 地址格式不正确');
rejects({ chainId: 'bitcoin', address: 'bc1qqqqqqqqqqqq', token: { symbol: 'BTC' } }, 'Bitcoin 地址格式不正确');
rejects({ chainId: 'ethereum', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', token: { symbol: 'ETH' } }, 'Ethereum 地址格式不正确');
rejects({ chainId: 'tron', address: 'THHkUaA5vipYRJV33mFN856wunvL5G6hXm', token: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6T' } }, '合约地址格式不正确');
rejects({ chainId: 'ethereum', address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', token: { contract: '0xdAC17F958D2ee523a2206206994597C13D831Ec7' } }, '合约地址格式不正确');
assert.strictEqual(normalizeRequest({ chainId: 'tron', address: 'THHkUaA5vipYRJV33mFN856wunvL5G6hXm', token: { symbol: 'USDT' } }).address, 'THHkUaA5vipYRJV33mFN856wunvL5G6hXm');
assert.strictEqual(normalizeRequest({ chainId: 'bitcoin', address: 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', token: { symbol: 'BTC' } }).chain.id, 'bitcoin');
assert.strictEqual(normalizeRequest({ chainId: 'ethereum', address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', token: { contract: '0xdac17f958d2ee523a2206206994597c13d831ec7' } }).token.symbol, 'USDT');
assert.strictEqual(normalizeRequest({ chainId: 'tron', address: 'TCGvM8LDb8pACZx8uD9hBhW6mconpAiXzS', token: { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' } }).token.symbol, 'USDT');
passed += 4;

console.log(`address-test: ${passed} 项断言全部通过`);
