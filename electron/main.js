const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const { CHAINS } = require('./chains');
const { queryLedger } = require('./providers');
const { getPrices } = require('./providers/prices');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const APP_INDEX = path.join(__dirname, '..', 'dist', 'index.html');

// 所有渲染进程强制沙箱（必须在 ready 之前调用）
app.enableSandbox();

// ---- 可信来源判断：开发模式 = dev server 的 origin；生产模式 = dist/index.html ----
const DEV_ORIGIN = (() => {
  if (!DEV_URL) return null;
  try {
    return new URL(DEV_URL).origin;
  } catch {
    return null;
  }
})();

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isAppUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (DEV_URL) return DEV_ORIGIN !== null && u.origin === DEV_ORIGIN;
  if (u.protocol !== 'file:' || (u.host && u.host !== 'localhost')) return false;
  try {
    return samePath(fileURLToPath(u), APP_INDEX);
  } catch {
    return false;
  }
}

// ---- 允许用系统浏览器打开的外部链接：只限区块浏览器与 API Key 申请页 ----
const EXTERNAL_HOSTS = new Set(['etherscan.io', 'www.etherscan.io', 'trongrid.io', 'www.trongrid.io']);
for (const c of CHAINS) {
  try {
    if (c.explorer) EXTERNAL_HOSTS.add(new URL(c.explorer).hostname.toLowerCase());
  } catch {
    /* 配置错误的 explorer 直接忽略 */
  }
}

function safeExternalUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!EXTERNAL_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u.href;
}

// ---- 设置（API Key 等）保存在用户数据目录；API Key 用 safeStorage（DPAPI / Keychain / libsecret）加密 ----
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const SECRET_FIELDS = ['etherscanApiKey', 'tronApiKey'];
const ENC_PREFIX = 'safeStorage:v1:';
const MAX_SETTING_LEN = 512;

// Electron 45 起同步 API 已弃用：优先使用异步 API（同步 API 加密的数据可被异步 API 解密）
const HAS_ASYNC = typeof safeStorage.encryptStringAsync === 'function';

async function canEncrypt() {
  try {
    return HAS_ASYNC ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

async function encryptField(v, encrypt) {
  if (!v) return '';
  if (!encrypt) return v; // 系统不支持加密时才退回明文
  const buf = HAS_ASYNC ? await safeStorage.encryptStringAsync(v) : safeStorage.encryptString(v);
  return ENC_PREFIX + buf.toString('base64');
}

// 返回 { value, reEncrypt }
async function decryptField(v) {
  if (typeof v !== 'string' || !v) return { value: '', reEncrypt: false };
  if (!v.startsWith(ENC_PREFIX)) return { value: v, reEncrypt: true }; // 旧版明文
  const buf = Buffer.from(v.slice(ENC_PREFIX.length), 'base64');
  try {
    if (HAS_ASYNC) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf);
      return { value: result, reEncrypt: !!shouldReEncrypt };
    }
    return { value: safeStorage.decryptString(buf), reEncrypt: false };
  } catch {
    return { value: '', reEncrypt: false }; // 换机器 / 换用户后无法解密：当作未设置
  }
}

async function writeSettingsFile(clean) {
  const encrypt = await canEncrypt();
  const stored = { ...clean };
  for (const k of SECRET_FIELDS) stored[k] = await encryptField(clean[k], encrypt);
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function loadSettings() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return { etherscanApiKey: '', tronApiKey: '', proxy: '' };
  }
  if (!raw || typeof raw !== 'object') raw = {};
  const s = { proxy: typeof raw.proxy === 'string' ? raw.proxy : '' };
  let reEncrypt = false;
  for (const k of SECRET_FIELDS) {
    const d = await decryptField(raw[k]);
    s[k] = d.value;
    reEncrypt ||= d.reEncrypt;
  }
  // 旧版明文文件透明迁移为加密存储；密钥轮换时重新加密
  if (reEncrypt && (await canEncrypt())) {
    try {
      await writeSettingsFile(s);
    } catch {
      /* 迁移失败不影响本次读取 */
    }
  }
  return s;
}

async function saveSettings(s) {
  const clean = {
    etherscanApiKey: String(s.etherscanApiKey || '').trim(),
    tronApiKey: String(s.tronApiKey || '').trim(),
    proxy: String(s.proxy || '').trim(),
  };
  if (clean.proxy && !/^(https?|socks5?):\/\/[^\s/]+:\d+\/?$/i.test(clean.proxy)) {
    throw new Error('代理格式应为 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080');
  }
  await writeSettingsFile(clean);
  return clean;
}

// 留空则跟随系统代理
async function applyProxy(proxy) {
  await session.defaultSession.setProxy(proxy ? { proxyRules: proxy } : { mode: 'system' });
}

// ---- IPC 参数校验 ----
class IpcInputError extends Error {}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function jsonSize(v) {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Infinity;
  }
}

function expectNoArgs(args) {
  if (args.length !== 0) throw new IpcInputError('参数不正确');
}

function validateSettingsArg(args) {
  const [s] = args;
  if (args.length !== 1 || !isPlainObject(s) || jsonSize(s) > 4096) throw new IpcInputError('设置参数不正确');
  for (const k of Object.keys(s)) {
    if (!['etherscanApiKey', 'tronApiKey', 'proxy'].includes(k)) throw new IpcInputError('设置参数不正确');
    const v = s[k];
    if (v != null && (typeof v !== 'string' || v.length > MAX_SETTING_LEN)) throw new IpcInputError('设置参数不正确');
  }
  return s;
}

function validateQueryArg(args) {
  const [req] = args;
  if (args.length !== 1 || !isPlainObject(req) || jsonSize(req) >= 4096) throw new IpcInputError('请求参数不正确');
  return req;
}

const CSV_MAX_ROWS = 200_001; // 20 万条记录 + 表头
const CSV_MAX_COLS = 64;
const CSV_MAX_CELL = 4096;
const CSV_MAX_BYTES = 128 * 1024 * 1024;

function validateCsvArg(args) {
  const [p] = args;
  if (args.length !== 1 || !isPlainObject(p)) throw new IpcInputError('导出参数不正确');
  const { defaultName, rows } = p;
  if (typeof defaultName !== 'string' || defaultName.length > 1024) throw new IpcInputError('文件名不正确');
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > CSV_MAX_ROWS) throw new IpcInputError('导出行数不正确');
  let total = 0;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length > CSV_MAX_COLS) throw new IpcInputError('导出数据格式不正确');
    for (const c of r) {
      const t = typeof c;
      if (c == null || t === 'number' || t === 'boolean') {
        total += 24;
        continue;
      }
      if (t !== 'string' || c.length > CSV_MAX_CELL) throw new IpcInputError('导出数据格式不正确');
      total += c.length + 3;
    }
    if (total > CSV_MAX_BYTES) throw new IpcInputError('导出数据过大');
  }
  return { defaultName, rows };
}

function validateUrlArg(args) {
  const [url] = args;
  const safe = args.length === 1 ? safeExternalUrl(url) : null;
  if (!safe) throw new IpcInputError('只允许打开已知区块浏览器的 https 链接');
  return safe;
}

// 默认文件名包含上游数据（币种符号等），只保留安全字符并强制 .csv
function sanitizeFileName(name) {
  let base = String(name || '').replace(/\.csv$/i, '');
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^[._-]+/, '');
  base = base.slice(0, 120 - 4).replace(/[.]+$/, '');
  return (base || 'onledger-export') + '.csv';
}

// CSV 公式注入防护：以 = + - @ \t \r 开头的单元格加 ' 前缀，纯数字（含负数 / 小数）除外
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---- 发送方校验：只接受本应用窗口主框架、且当前页面为应用自身来源的调用 ----
const appWindows = new Set();

function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !appWindows.has(win)) return false;
  const main = event.sender.mainFrame;
  if (!main || frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
  return isAppUrl(frame.url);
}

// 统一包装：渲染进程拿到 {ok, data} 或 {ok:false, error}，避免 Electron 改写错误信息
function handle(channel, validate, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      console.warn(`[ipc] rejected ${channel} from untrusted sender: ${event.senderFrame?.url}`);
      return { ok: false, error: '拒绝访问' };
    }
    try {
      const input = validate(args);
      return { ok: true, data: await fn(input, event) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('chains:list', expectNoArgs, () => CHAINS);
  handle('prices:get', expectNoArgs, () => getPrices());
  handle('settings:get', expectNoArgs, () => loadSettings());
  handle('settings:set', validateSettingsArg, async (s) => {
    const saved = await saveSettings(s);
    await applyProxy(saved.proxy);
    return saved;
  });
  handle('ledger:query', validateQueryArg, async (req) => queryLedger(req, await loadSettings()));

  handle('export:csv', validateCsvArg, async ({ defaultName, rows }, event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: sanitizeFileName(defaultName),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    const target = /\.csv$/i.test(filePath) ? filePath : `${filePath}.csv`;
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    fs.writeFileSync(target, '\uFEFF' + csv, 'utf8'); // BOM：Excel 正确识别中文
    return target;
  });

  handle('shell:open', validateUrlArg, (url) => shell.openExternal(url));
}

// ---- 所有 webContents：禁止离开应用来源的导航、禁止 webview、新窗口只交给系统浏览器 ----
app.on('web-contents-created', (_e, contents) => {
  const blockForeign = (event, legacyUrl) => {
    const url = event.url || legacyUrl;
    if (!isAppUrl(url)) {
      event.preventDefault();
      console.warn(`[nav] blocked navigation to ${url}`);
    }
  };
  contents.on('will-navigate', blockForeign);
  contents.on('will-frame-navigate', blockForeign);
  contents.on('will-redirect', blockForeign);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url);
    if (safe) shell.openExternal(safe);
    return { action: 'deny' };
  });
});

function setupSessionSecurity() {
  const ses = session.defaultSession;
  // 剪贴板写入（复制哈希 / 地址）仅对应用自身页面开放，其余权限一律拒绝
  const allowed = (permission, url) => permission === 'clipboard-sanitized-write' && isAppUrl(url);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed(permission, details?.requestingUrl || wc?.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return allowed(permission, details?.requestingUrl || wc?.getURL());
  });
  ses.setDevicePermissionHandler(() => false);
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
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  appWindows.add(win);
  win.on('closed', () => appWindows.delete(win));

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(APP_INDEX);
  }
}

app.whenReady().then(async () => {
  setupSessionSecurity();
  await applyProxy((await loadSettings()).proxy);
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
