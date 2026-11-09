// TRON：账单来自 TronGrid v1 API（仅 TronGrid 提供按地址的交易历史）https://developers.tron.network/reference
// 余额来自多个公开全节点（/wallet/* 接口兼容），轮询 + 失败切换，减轻 TronGrid 的限流压力
const { getJSON, getJSONAny, formatUnits, tronHexToBase58 } = require('./util');

const API = 'https://api.trongrid.io';
const FULL_NODES = ['https://tron-rpc.publicnode.com', 'https://api.tronstack.io', 'https://api.trongrid.io'];
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PAGE_SIZE = 50;

function headers(settings) {
  return settings.tronApiKey ? { 'TRON-PRO-API-KEY': settings.tronApiKey } : {};
}

async function call(path, params, settings) {
  const qs = new URLSearchParams(params);
  // 无 Key 时 TronGrid 约 1 次/秒（util 中默认间隔），有 Key 时恢复正常间隔
  const data = await getJSON(`${API}${path}?${qs}`, {
    headers: headers(settings),
    minInterval: settings.tronApiKey ? 220 : undefined,
  });
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

// base58 TRON 地址 -> 20 字节地址的 hex（不含 41 前缀）；地址已在入口处做过校验和校验
function tronToHex20(addr) {
  let n = 0n;
  for (const c of addr) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(50, '0').slice(2, 42);
}

const fullNode = (path, body) => getJSONAny(FULL_NODES, path, { body });

async function balance({ token, address }) {
  if (token.native) {
    const acc = await fullNode('/wallet/getaccount', { address, visible: true });
    if (!acc || typeof acc !== 'object') throw new Error('余额查询失败');
    return formatUnits(acc.balance || 0, token.decimals); // 未激活账户返回 {}，余额为 0
  }
  // TRC-20：直接调用合约 balanceOf(address)
  const r = await fullNode('/wallet/triggerconstantcontract', {
    owner_address: address,
    contract_address: token.contract,
    function_selector: 'balanceOf(address)',
    parameter: tronToHex20(address).padStart(64, '0'),
    visible: true,
  });
  const hex = r?.constant_result?.[0];
  if (!r?.result?.result || typeof hex !== 'string' || !/^[0-9a-f]{1,64}$/i.test(hex)) throw new Error('余额查询失败');
  return token.decimals != null ? formatUnits(BigInt('0x' + hex).toString(), token.decimals) : null;
}

module.exports = { query, balance };
