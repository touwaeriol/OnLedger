# OnLedger · 链上账单查询

一个跨平台（Windows / macOS）桌面工具，同时提供网页版：选择 **链 + 币种**，输入 **地址**，查询该地址的转入/转出账单。

技术栈：Electron + React 19 + Ant Design 6 + Vite；网页版后端为纯 Node.js，Docker Compose 部署。

## 功能

- 支持的链与币种

  | 链 | 币种 | 数据源 |
  | --- | --- | --- |
  | Ethereum / BNB Smart Chain / Polygon / Arbitrum One / Base / Optimism | 原生币（ETH/BNB/POL）、USDT、USDC、**任意自定义 ERC-20 合约** | Etherscan V2 API（需 API Key） |
  | TRON | TRX、USDT、USDC、**任意自定义 TRC-20 合约** | TronGrid（Key 可选） |
  | Bitcoin | BTC | mempool.space（无需 Key） |

- 账单明细：时间、转入/转出、金额、对方地址、手续费、状态、交易哈希（点击跳转区块浏览器）
- 汇总：当前余额、转入合计、转出合计、手续费合计（基于已加载记录）
- 分页：「加载更多」/「加载全部」（最多 100 页，可随时停止）
- 筛选：按方向（全部/转入/转出）、按哈希或地址关键字
- 导出 CSV（带 BOM，Excel 直接打开不乱码）
- 查询历史（按链记忆最近 30 个地址）、暗色模式
- CSV 导出已防公式注入
- 设置：Etherscan API Key、TronGrid API Key、网络代理（默认跟随系统代理）

所有金额使用 BigInt 计算，不会有浮点误差。

## 开始使用

需要 Node.js ≥ 22.12。

```bash
npm install
```

开发模式（Vite 热更新 + Electron 窗口）：

```bash
npm run dev
```

以生产构建运行：

```bash
npm start
```

首次使用 EVM 链前，点右上角「设置」填入 Etherscan API Key（免费申请：https://etherscan.io/apis）。一个 Key 通用于所有 EVM 链；但 Etherscan 免费套餐可能不包含部分链（如 BSC、Base、Optimism），查询时会返回相应错误提示。

## 打包

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

产物在 `release/`：Windows 生成 NSIS 安装包和便携版 exe，macOS 生成 dmg 和 zip。

- macOS 安装包需要在 Mac 上打包（或用 macOS CI）；未签名的 app 首次打开需在「系统设置 → 隐私与安全性」中允许。
- 目前使用 Electron 默认图标，可在 `build` 中配置 `icon`。

## 网页版（在线服务）

同一套界面也可以作为网站运行：后端 `server/server.js` 只用 Node 内置模块（无第三方运行时依赖），提供 `/api/chains`、`/api/ledger` 并托管前端静态文件。网页版没有「设置」，API Key 只保存在服务器环境变量中，不会下发到浏览器。

本地开发（后端 + Vite 热更新）：

```bash
npm run dev:web
```

### Docker Compose 部署

```bash
cp .env.example .env
```

在 `.env` 中填写 `ETHERSCAN_API_KEY`（不填则 EVM 链不可查询）、可选的 `TRON_API_KEY`，然后：

```bash
docker compose up -d --build
```

容器只监听 `127.0.0.1:8096`，需要由宿主机上的反向代理（如 Caddy）对外提供 HTTPS：

```
onledger.example.com {
    reverse_proxy 127.0.0.1:8096
}
```

安全措施：严格输入校验、按 IP 限流、并发上限、同源校验、上游请求限速与结果短缓存、CSP 等安全响应头、防路径穿越；容器以非 root、只读文件系统、去除全部 capabilities 运行。

## 项目结构

```
electron/
  main.js            主进程：窗口、IPC、设置存储、代理、CSV 导出
  preload.js         通过 contextBridge 暴露 window.onledger API
  chains.js          链与币种配置（新增链/币种改这里）
  providers/
    index.js         统一入口：校验地址、分发到对应 provider、附带余额
    evm.js           Etherscan V2（txlist / tokentx / balance）
    tron.js          TronGrid（TRX 转账 / TRC-20 转账 / 余额）
    btc.js           mempool.space（按地址净额计算转入/转出）
    util.js          HTTP（Electron 中走 net.fetch，自动使用系统代理）、精度换算、TRON 地址转换
src/                 React + antd 界面（src/api.js：桌面端走 IPC，网页端走 HTTP）
server/server.js     网页版后端
Dockerfile, docker-compose.yml
scripts/
  smoke-test.js      联网冒烟测试
```

网络请求都在主进程中发起（没有 CORS 限制，API Key 不暴露给页面）；渲染进程开启了 `contextIsolation` + `sandbox`，打包产物带 CSP。

### 新增一条 EVM 链

在 `electron/chains.js` 中添加一项，填入 Etherscan V2 支持的 `chainId`、区块浏览器地址和币种即可，无需改其他代码。

## 测试

```bash
npm run test:providers
```

会对 BTC、TRON 实际发起请求并检查分页；设置环境变量 `ETHERSCAN_API_KEY` 后也会测试 Ethereum。需要代理时：

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 npm run test:providers
```

## 说明与限制

- **BTC 金额口径**：每笔交易按本地址的净变化计算；本地址发出的交易中，手续费单独列出，金额为转给他人的部分。找零回本地址不计为转出。
- **TRX 账单**只包含 TRX 转账（TransferContract），不含合约调用中的 TRX 变化和内部交易。
- **EVM 原生币账单**来自 `txlist`，不含内部交易（合约转给你的 ETH）。
- Etherscan 分页最多翻到第 10000 条记录。
- 汇总数字基于当前已加载的记录；要统计全部历史，先点「加载全部」。

## 常见问题

- **请求超时 / 网络连接失败**：默认跟随系统代理；如果用的是没有设为系统代理的代理软件，在「设置 → 网络代理」中填写，如 `http://127.0.0.1:7890`。
- **`npm install` 后无法启动 Electron**：执行 `node node_modules/electron/install.js` 下载 Electron 二进制（postinstall 会自动执行）。
- **`vite build` 报 `Cannot find native binding`**（npm 可选依赖的已知问题）：删除 `node_modules` 和 `package-lock.json` 后重新 `npm install`。
