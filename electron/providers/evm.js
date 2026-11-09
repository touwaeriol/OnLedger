// EVM 链：Etherscan V2 多链 API，一个 Key 通用 https://docs.etherscan.io/
const { getJSON, formatUnits } = require('./util');

const API = 'https://api.etherscan.io/v2/api';
const PAGE_SIZE = 50;

async function call(chain, params, apiKey) {
  if (!apiKey) throw new Error('EVM 链需要 Etherscan API Key，请在「设置」中填写（免费申请: etherscan.io/apis）');
  const qs = new URLSearchParams({ chainid: String(chain.chainId), ...params, apikey: apiKey });
  const data = await getJSON(`${API}?${qs}`);
  if (data.status === '1') return data.result;
  // 无记录时 status=0，result=[]
  if (Array.isArray(data.result) && /no (transactions|records)/i.test(data.message || '')) return [];
  const detail = typeof data.result === 'string' ? data.result : data.message;
  throw new Error(`Etherscan: ${detail || '未知错误'}`);
}

function direction(addr, from, to) {
  const a = addr.toLowerCase();
  const f = (from || '').toLowerCase();
  const t = (to || '').toLowerCase();
  if (f === a && t === a) return 'self';
  return f === a ? 'out' : 'in';
}

async function query({ chain, token, address, cursor, settings }) {
  const apiKey = settings.etherscanApiKey;
  const page = cursor ? Number(cursor) : 1;
  const common = {
    module: 'account',
    address,
    startblock: '0',
    endblock: '99999999',
    page: String(page),
    offset: String(PAGE_SIZE),
    sort: 'desc',
  };

  let records;
  if (token.native) {
    const list = await call(chain, { ...common, action: 'txlist' }, apiKey);
    records = list.map((tx) => {
      const dir = direction(address, tx.from, tx.to);
      const fee = BigInt(tx.gasUsed || 0) * BigInt(tx.gasPrice || 0);
      return {
        hash: tx.hash,
        time: Number(tx.timeStamp) * 1000,
        block: Number(tx.blockNumber),
        from: tx.from,
        to: tx.to || tx.contractAddress,
        direction: dir,
        value: tx.value,
        decimals: token.decimals,
        symbol: token.symbol,
        // 手续费由发起方支付，只有本地址发出的交易才计入
        fee: dir === 'in' ? null : fee.toString(),
        feeDecimals: token.decimals,
        feeSymbol: token.symbol,
        status: tx.isError === '1' || tx.txreceipt_status === '0' ? 'failed' : 'success',
        method: tx.functionName ? tx.functionName.split('(')[0] : '',
      };
    });
  } else {
    const list = await call(chain, { ...common, action: 'tokentx', contractaddress: token.contract }, apiKey);
    records = list.map((tx) => ({
      hash: tx.hash,
      time: Number(tx.timeStamp) * 1000,
      block: Number(tx.blockNumber),
      from: tx.from,
      to: tx.to,
      direction: direction(address, tx.from, tx.to),
      value: tx.value,
      decimals: Number(tx.tokenDecimal),
      symbol: tx.tokenSymbol || token.symbol,
      fee: null,
      status: 'success',
      method: 'transfer',
    }));
  }

  // Etherscan 分页上限 page*offset <= 10000
  const nextCursor = records.length === PAGE_SIZE && page * PAGE_SIZE < 10000 ? String(page + 1) : null;
  return { records, nextCursor };
}

async function balance({ chain, token, address, settings }) {
  const apiKey = settings.etherscanApiKey;
  if (token.native) {
    const raw = await call(chain, { module: 'account', action: 'balance', address, tag: 'latest' }, apiKey);
    return formatUnits(raw, token.decimals);
  }
  const raw = await call(
    chain,
    { module: 'account', action: 'tokenbalance', contractaddress: token.contract, address, tag: 'latest' },
    apiKey
  );
  return token.decimals != null ? formatUnits(raw, token.decimals) : null;
}

module.exports = { query, balance };
