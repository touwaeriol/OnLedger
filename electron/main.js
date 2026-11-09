const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { CHAINS } = require('./chains');
const { queryLedger } = require('./providers');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// ---- 设置（API Key 等）保存在用户数据目录 ----
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return { etherscanApiKey: '', tronApiKey: '', proxy: '' };
  }
}

function saveSettings(s) {
  const clean = {
    etherscanApiKey: String(s.etherscanApiKey || '').trim(),
    tronApiKey: String(s.tronApiKey || '').trim(),
    proxy: String(s.proxy || '').trim(),
  };
  if (clean.proxy && !/^(https?|socks5?):\/\/[^\s/]+:\d+\/?$/i.test(clean.proxy)) {
    throw new Error('代理格式应为 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080');
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(clean, null, 2));
  return clean;
}

// 留空则跟随系统代理
async function applyProxy(proxy) {
  await session.defaultSession.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' });
}

// 统一包装：渲染进程拿到 {ok, data} 或 {ok:false, error}，避免 Electron 改写错误信息
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('chains:list', () => CHAINS);
  handle('settings:get', () => loadSettings());
  handle('settings:set', async (s) => {
    const saved = saveSettings(s);
    await applyProxy(saved.proxy);
    return saved;
  });
  handle('ledger:query', (req) => queryLedger(req, loadSettings()));

  handle('export:csv', async ({ defaultName, rows }) => {
    const win = BrowserWindow.getFocusedWindow();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    const esc = (v) => {
      let s = v == null ? '' : String(v);
      // 防止 CSV 公式注入（Excel 会执行以 = + - @ 开头的单元格）
      if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    fs.writeFileSync(filePath, '\uFEFF' + csv, 'utf8'); // BOM：Excel 正确识别中文
    return filePath;
  });

  handle('shell:open', (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('只允许打开 https 链接');
    return shell.openExternal(url);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'OnLedger',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 页面内的链接一律用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  await applyProxy(loadSettings().proxy);
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
