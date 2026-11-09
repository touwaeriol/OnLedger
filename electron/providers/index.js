const { getChain } = require('../chains');
const { isValidAddress } = require('./address');

const PROVIDERS = {
  evm: require('./evm'),
  tron: require('./tron'),
  btc: require('./btc'),
};

// 各链分页游标的合法格式（游标会拼进上游 URL，必须严格校验）
const CURSOR_RULES = {
  evm: /^(?:[2-9]|[1-9]\d|1\d\d|200)$/, // 页码 2..200（Etherscan 上限 10000 条 / 每页 50）
  tron: /^[A-Za-z0-9+/=_-]{1,512}$/, // TronGrid fingerprint
  btc: /^[0-9a-f]{64}$/, // 上一页最后一条已确认交易的 txid
};

class InputError extends Error {}

function str(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function resolveToken(chain, tokenReq) {
  if (!tokenReq || typeof tokenReq !== 'object' || Array.isArray(tokenReq)) throw new InputError('币种参数不正确');
  if (tokenReq.contract != null) {
    const contract = str(tokenReq.contract, 100);
    if (!contract) throw new InputError('合约地址格式不正确');
    if (chain.type === 'btc') throw new InputError('Bitcoin 不支持代币合约');
    if (!new RegExp(chain.addressPattern).test(contract) || !isValidAddress(chain.type, contract)) throw new InputError('合约地址格式不正确');
    const known = chain.tokens.find((t) => t.contract && t.contract.toLowerCase() === contract.toLowerCase());
    if (known) return known;
    return { symbol: 'TOKEN', contract, decimals: undefined };
  }
  const symbol = str(tokenReq.symbol, 20);
  const token = symbol && chain.tokens.find((t) => t.symbol === symbol);
  if (!token) throw new InputError(`${chain.name} 不支持该币种`);
  return token;
}

/**
 * 校验并规范化查询参数。所有外部输入（网页请求 / IPC）都必须先经过这里。
 * @returns {{chain, token, address, cursor}}
 */
function normalizeRequest(req) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new InputError('请求参数不正确');
  const chainId = str(req.chainId, 32);
  let chain;
  try {
    chain = getChain(chainId);
  } catch {
    throw new InputError('不支持的链');
  }
  const address = str(req.address, 100);
  if (!address || !new RegExp(chain.addressPattern).test(address) || !isValidAddress(chain.type, address)) {
    throw new InputError(`${chain.name} 地址格式不正确`);
  }
  const token = resolveToken(chain, req.token);
  let cursor = null;
  if (req.cursor != null && req.cursor !== '') {
    cursor = str(req.cursor, 512);
    if (!cursor || !CURSOR_RULES[chain.type].test(cursor)) throw new InputError('分页参数不正确');
  }
  return { chain, token, address, cursor };
}

/**
 * 查询账单
 * @param {{chainId:string, token:{symbol?:string, contract?:string}, address:string, cursor?:string}} req
 * @returns {Promise<{records:object[], nextCursor:string|null, balance?:string|null, balanceError?:string}>}
 */
async function queryLedger(req, settings) {
  const { chain, token, address, cursor } = normalizeRequest(req);
  const provider = PROVIDERS[chain.type];
  const ctx = { chain, token, address, cursor, settings };

  const result = await provider.query(ctx);
  for (const r of result.records) r.explorerUrl = chain.explorer + encodeURIComponent(r.hash);

  // 首页同时查询当前余额；余额失败不影响账单展示
  if (!cursor) {
    try {
      const t = { ...token };
      if (t.decimals == null && result.records[0]) t.decimals = result.records[0].decimals;
      result.balance = await provider.balance({ ...ctx, token: t });
      result.balanceSymbol = result.records[0]?.symbol || token.symbol;
    } catch (e) {
      result.balance = null;
      result.balanceError = e.message;
    }
  }
  return result;
}

module.exports = { queryLedger, normalizeRequest, InputError };
