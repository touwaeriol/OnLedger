// TRON：TronGrid v1 API https://developers.tron.network/reference
const { getJSON, formatUnits, tronHexToBase58 } = require('./util');

const API = 'https://api.trongrid.io';
const PAGE_SIZE = 50;

function headers(settings) {
  return settings.tronApiKey ? { 'TRON-PRO-API-KEY': settings.tronApiKey } : {};
}

async function call(path, params, settings) {
  const qs = new URLSearchParams(params);
  const data = await getJSON(`${API}${path}?${qs}`, { headers: headers(settings) });
  if (data.success === false) throw new Error(`TronGrid: ${data.error || '未知错误'}`);
  return data;
}

function direction(addr, from, to) {
  if (from === addr && to === addr) return 'self';
  return from === addr ? 'out' : 'in';
}

async function query({ token, address, cursor, settings }) {
  const params = { limit: String(PAGE_SIZE), only_confirmed: 'true', order_by: 'block_timestamp,desc' };
  if (cursor) params.fingerprint = cursor;

  let records;
  let data;
  if (token.native) {
    data = await call(`/v1/accounts/${address}/transactions`, { ...params, search_internal: 'false' }, settings);
    records = [];
    for (const tx of data.data || []) {
      const c = tx.raw_data?.contract?.[0];
      // 只保留 TRX 转账（TransferContract），合约调用等不计入 TRX 账单
      if (!c || c.type !== 'TransferContract') continue;
      const v = c.parameter.value;
      const from = tronHexToBase58(v.owner_address);
      const to = tronHexToBase58(v.to_address);
      const dir = direction(address, from, to);
      const fee = (tx.net_fee || 0) + (tx.energy_fee || 0) || tx.ret?.[0]?.fee || 0;
      records.push({
        hash: tx.txID,
        time: tx.block_timestamp,
        block: tx.blockNumber,
        from,
        to,
        direction: dir,
        value: String(v.amount || 0),
        decimals: token.decimals,
        symbol: token.symbol,
        fee: dir === 'in' ? null : String(fee),
        feeDecimals: 6,
        feeSymbol: 'TRX',
        status: tx.ret?.[0]?.contractRet === 'SUCCESS' ? 'success' : 'failed',
        method: 'transfer',
      });
    }
  } else {
    data = await call(
      `/v1/accounts/${address}/transactions/trc20`,
      { ...params, contract_address: token.contract },
      settings
    );
    records = (data.data || [])
      .filter((tx) => tx.type === 'Transfer')
      .map((tx) => ({
        hash: tx.transaction_id,
        time: tx.block_timestamp,
        block: null,
        from: tx.from,
        to: tx.to,
        direction: direction(address, tx.from, tx.to),
        value: tx.value,
        decimals: Number(tx.token_info?.decimals ?? token.decimals ?? 0),
        symbol: tx.token_info?.symbol || token.symbol,
        fee: null,
        status: 'success',
        method: 'transfer',
      }));
  }

  return { records, nextCursor: data.meta?.fingerprint || null };
}

async function balance({ token, address, settings }) {
  const data = await call(`/v1/accounts/${address}`, {}, settings);
  const acc = data.data?.[0];
  if (!acc) return '0'; // 未激活账户
  if (token.native) return formatUnits(acc.balance || 0, token.decimals);
  const item = (acc.trc20 || []).find((o) => Object.keys(o)[0] === token.contract);
  const raw = item ? item[token.contract] : '0';
  return token.decimals != null ? formatUnits(raw, token.decimals) : null;
}

module.exports = { query, balance };
