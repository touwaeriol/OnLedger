const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || !res.ok) throw new Error((res && res.error) || '调用失败');
  return res.data;
}

// 禁止把文件 / 链接拖进窗口（否则会触发导航）
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (e) => e.preventDefault());

contextBridge.exposeInMainWorld('onledger', {
  listChains: () => invoke('chains:list'),
  getPrices: () => invoke('prices:get'),
  getSettings: () => invoke('settings:get'),
  saveSettings: (s) => invoke('settings:set', s),
  queryLedger: (req) => invoke('ledger:query', req),
  exportCsv: (defaultName, rows) => invoke('export:csv', { defaultName, rows }),
  openExternal: (url) => invoke('shell:open', url),
});
