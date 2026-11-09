// 整数字符串 + 精度 -> 十进制字符串（BigInt，避免浮点误差）
export function formatUnits(raw, decimals) {
  const d = Math.min(Math.max(Math.trunc(Number(decimals)) || 0, 0), 255);
  let v = BigInt(raw || 0);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(d);
  const int = v / base;
  const frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + int.toString() + (frac ? '.' + frac : '');
}

// 千分位，保留全部小数
export function prettyAmount(str) {
  const [i, f] = String(str).split('.');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${int}.${f}` : int;
}

export function shortAddr(a, head = 6, tail = 4) {
  if (!a || a.length <= head + tail + 3) return a || '';
  return `${a.slice(0, head)}...${a.slice(-tail)}`;
}

// 汇总已加载记录（同一币种精度一致）
export function summarize(records) {
  let inSum = 0n;
  let outSum = 0n;
  let feeSum = 0n;
  let inCount = 0;
  let outCount = 0;
  for (const r of records) {
    if (r.status === 'failed') {
      if (r.fee) feeSum += BigInt(r.fee);
      continue;
    }
    if (r.direction === 'in') {
      inSum += BigInt(r.value);
      inCount++;
    } else if (r.direction === 'out') {
      outSum += BigInt(r.value);
      outCount++;
    }
    if (r.fee) feeSum += BigInt(r.fee);
  }
  const first = records[0];
  return {
    decimals: first?.decimals ?? 0,
    symbol: first?.symbol ?? '',
    feeDecimals: records.find((r) => r.feeDecimals != null)?.feeDecimals ?? 0,
    feeSymbol: records.find((r) => r.feeSymbol)?.feeSymbol ?? '',
    inSum,
    outSum,
    feeSum,
    inCount,
    outCount,
  };
}

const HISTORY_KEY = 'onledger.history';

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

export function pushHistory(item) {
  const list = loadHistory().filter(
    (h) => !(h.chainId === item.chainId && h.address === item.address && h.tokenKey === item.tokenKey)
  );
  list.unshift({ ...item, at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
}

export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}
