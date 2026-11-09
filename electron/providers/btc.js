// Bitcoin：mempool.space (Esplora) API https://mempool.space/docs/api/rest
const { getJSON, formatUnits } = require('./util');

const API = 'https://mempool.space/api';
const CONFIRMED_PAGE = 25; // Esplora 每页 25 条已确认交易

function toRecord(tx, address, token) {
  let received = 0n;
  let spent = 0n;
  let allInputsMine = true;
  for (const vin of tx.vin) {
    const a = vin.prevout?.scriptpubkey_address;
    if (a === address) spent += BigInt(vin.prevout.value);
    else allInputsMine = false;
  }
  for (const vout of tx.vout) {
    if (vout.scriptpubkey_address === address) received += BigInt(vout.value);
  }
  const net = received - spent;
  const fee = BigInt(tx.fee || 0);

  let dir;
  let amount;
  if (net >= 0n) {
    dir = spent > 0n ? 'self' : 'in';
    amount = net;
  } else {
    dir = 'out';
    // 本地址支付了全部输入时，手续费单独列出，金额只算转给别人的部分
    amount = allInputsMine ? -net - fee : -net;
  }

  const inAddrs = [...new Set(tx.vin.map((v) => v.prevout?.scriptpubkey_address).filter(Boolean))];
  const outAddrs = [...new Set(tx.vout.map((v) => v.scriptpubkey_address).filter(Boolean))];
  const others = (list) => list.filter((a) => a !== address);
  const summarize = (list) => (list.length > 1 ? `${list[0]} 等${list.length}个` : list[0] || '');

  return {
    hash: tx.txid,
    time: tx.status?.block_time ? tx.status.block_time * 1000 : null,
    block: tx.status?.block_height ?? null,
    from: dir === 'in' ? summarize(others(inAddrs)) || 'coinbase' : address,
    to: dir === 'out' ? summarize(others(outAddrs)) : address,
    direction: dir,
    value: amount.toString(),
    decimals: token.decimals,
    symbol: 'BTC',
    fee: dir === 'in' ? null : fee.toString(),
    feeDecimals: 8,
    feeSymbol: 'BTC',
    status: tx.status?.confirmed ? 'success' : 'pending',
    method: '',
  };
}

async function query({ token, address, cursor }) {
  // 首页：最多 50 条未确认 + 25 条已确认；之后用最后一个已确认 txid 翻页
  const url = cursor ? `${API}/address/${address}/txs/chain/${cursor}` : `${API}/address/${address}/txs`;
  const list = await getJSON(url);
  const confirmed = list.filter((tx) => tx.status?.confirmed);
  const nextCursor = confirmed.length >= CONFIRMED_PAGE ? confirmed[confirmed.length - 1].txid : null;
  return { records: list.map((tx) => toRecord(tx, address, token)), nextCursor };
}

async function balance({ token, address }) {
  const d = await getJSON(`${API}/address/${address}`);
  const c = d.chain_stats;
  const m = d.mempool_stats;
  const sats =
    BigInt(c.funded_txo_sum) - BigInt(c.spent_txo_sum) + BigInt(m.funded_txo_sum) - BigInt(m.spent_txo_sum);
  return formatUnits(sats, token.decimals);
}

module.exports = { query, balance };
