// 统一的前端 API：桌面端走 Electron preload 暴露的 window.onledger，网页端走后端 HTTP 接口
const isDesktop = typeof window !== 'undefined' && !!window.onledger;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      throw new Error('网络连接失败，请检查网络后重试');
    }
    // 被限流时按 Retry-After 等待后自动重试（最多 3 次）
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 30);
      await sleep(wait * 1000);
      continue;
    }
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`服务器错误 (HTTP ${res.status})`);
    }
    if (!res.ok || !json.ok) throw new Error(json.error || `服务器错误 (HTTP ${res.status})`);
    return json.data;
  }
}

function downloadCsv(name, rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    // 防止 CSV 公式注入（Excel 会执行以 = + - @ 开头的单元格）
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

const webApi = {
  isDesktop: false,
  listChains: () => http('/api/chains'),
  getPrices: () => http('/api/prices'),
  queryLedger: (req) => http('/api/ledger', { method: 'POST', body: req }),
  exportCsv: async (name, rows) => downloadCsv(name, rows),
  openExternal: async (url) => {
    if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  },
};

const desktopApi = isDesktop ? { isDesktop: true, ...window.onledger } : null;

export const api = desktopApi || webApi;
