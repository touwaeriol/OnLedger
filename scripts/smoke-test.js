// 直接调用 providers 做联网冒烟测试：npm run test:providers
// 可选环境变量 ETHERSCAN_API_KEY / TRON_API_KEY
// 需要代理时：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm run test:providers
const { queryLedger } = require('../electron/providers');
const { formatUnits, tronHexToBase58 } = require('../electron/providers/util');
const assert = require('node:assert');

const settings = {
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || '',
  tronApiKey: process.env.TRON_API_KEY || '',
};

const CASES = [
  { chainId: 'bitcoin', token: { symbol: 'BTC' }, address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' },
  { chainId: 'tron', token: { symbol: 'USDT' }, address: 'TCGvM8LDb8pACZx8uD9hBhW6mconpAiXzS' },
  { chainId: 'tron', token: { symbol: 'TRX' }, address: 'TCGvM8LDb8pACZx8uD9hBhW6mconpAiXzS' },
  { chainId: 'ethereum', token: { symbol: 'ETH' }, address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  { chainId: 'ethereum', token: { symbol: 'USDT' }, address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
];

function unitTests() {
  assert.strictEqual(formatUnits('1500000', 6), '1.5');
  assert.strictEqual(formatUnits('1000000000000000000', 18), '1');
  assert.strictEqual(formatUnits('1', 18), '0.000000000000000001');
  assert.strictEqual(formatUnits('-250', 2), '-2.5');
  // USDT-TRC20 合约 hex <-> base58
  assert.strictEqual(tronHexToBase58('41a614f803b6fd780986a42c78ec9c7f77e6ded13c'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  console.log('✔ unit tests passed');
}

async function main() {
  unitTests();
  let failed = 0;
  for (const c of CASES) {
    const label = `${c.chainId}/${c.token.symbol}`;
    if (c.chainId === 'ethereum' && !settings.etherscanApiKey) {
      console.log(`- ${label}: 跳过（未设置 ETHERSCAN_API_KEY）`);
      continue;
    }
    try {
      const first = await queryLedger(c, settings);
      console.log(
        `✔ ${label}: ${first.records.length} 条, 余额=${first.balance ?? first.balanceError}, next=${first.nextCursor ? 'yes' : 'no'}`
      );
      const r = first.records[0];
      if (r) console.log('   ', JSON.stringify({ ...r, value: formatUnits(r.value, r.decimals) }));
      if (first.nextCursor) {
        const second = await queryLedger({ ...c, cursor: first.nextCursor }, settings);
        const dup = second.records.some((x) => first.records.some((y) => y.hash === x.hash && y.value === x.value));
        console.log(`   第2页: ${second.records.length} 条${dup ? '（⚠ 与第1页有重复）' : ''}`);
      }
    } catch (e) {
      failed++;
      console.log(`✘ ${label}: ${e.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
