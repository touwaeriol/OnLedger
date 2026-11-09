// 原生币 USD 价格：CoinGecko 免 Key 接口，缓存 5 分钟；失败时返回近似兜底价（只用于「过滤小额」的默认阈值）
const { getJSON } = require('./util');

const IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BNB: 'binancecoin',
  POL: 'polygon-ecosystem-token',
  TRX: 'tron',
};

// 兜底价格（2026-11 近似值），价格接口不可用时使用
const FALLBACK = { BTC: 75000, ETH: 2100, BNB: 690, POL: 0.09, TRX: 0.32 };

const TTL_MS = 5 * 60 * 1000;
let cache = null; // { prices, updatedAt, source }
let inflight = null;

async function fetchPrices() {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${Object.values(IDS).join(',')}&vs_currencies=usd`;
  const data = await getJSON(url, { timeout: 10000 });
  const prices = { USDT: 1, USDC: 1 };
  for (const [sym, id] of Object.entries(IDS)) {
    const p = Number(data?.[id]?.usd);
    // 只接受合理的正数，防止异常数据
    prices[sym] = Number.isFinite(p) && p > 0 && p < 1e9 ? p : FALLBACK[sym];
  }
  return { prices, updatedAt: Date.now(), source: 'coingecko' };
}

/** 永不抛错：失败时返回上次缓存或兜底价；最多等 3 秒，超时先返回兜底价，后台继续刷新 */
async function getPrices() {
  if (cache && Date.now() - cache.updatedAt < TTL_MS) return cache;
  if (!inflight) {
    inflight = fetchPrices()
      .then((r) => (cache = r))
      .catch(() => {
        // 失败后 1 分钟内不再重试，避免价格接口故障时反复请求
        const base = cache || { prices: { ...FALLBACK, USDT: 1, USDC: 1 }, source: 'fallback' };
        cache = { ...base, updatedAt: Date.now() - TTL_MS + 60 * 1000 };
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const quick = new Promise((r) =>
    setTimeout(() => r(cache || { prices: { ...FALLBACK, USDT: 1, USDC: 1 }, updatedAt: Date.now(), source: 'fallback' }), 3000).unref?.()
  );
  return Promise.race([inflight, quick]);
}

module.exports = { getPrices };
