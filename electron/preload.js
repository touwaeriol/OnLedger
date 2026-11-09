const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

contextBridge.exposeInMainWorld('onledger', {
  listChains: () => invoke('chains:list'),
  getSettings: () => invoke('settings:get'),
  saveSettings: (s) => invoke('settings:set', s),
  queryLedger: (req) => invoke('ledger:query', req),
  exportCsv: (defaultName, rows) => invoke('export:csv', { defaultName, rows }),
  openExternal: (url) => invoke('shell:open', url),
});
