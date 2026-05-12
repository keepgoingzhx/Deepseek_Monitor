# DeepSeek Monitor

DeepSeek Monitor 是一个本地 DeepSeek token 用量监控工具。它可以启动一个只监听本机的接口服务，转发 DeepSeek 请求，读取响应中的 `usage` 字段并累计 token；桌面端会展示今日、本月、趋势、余额、最近明细和接口状态。

DeepSeek 官方目前没有提供“直接查询历史 token 用量”的公开 API。可靠的统计方式是记录每次模型响应里的 `usage` 字段，所以本项目通过本地代理记录你自己的请求用量，也支持导入 DeepSeek Usage 页面导出的 CSV/ZIP 来补历史数据。

## 功能

- 桌面小窗口：支持拖动、置顶、托盘常驻和紧凑模式。
- 本地接口：默认运行在 `http://127.0.0.1:8787`。
- 用量统计：展示今日 token、本月 token、今日请求数、最近趋势和明细。
- 余额查询：可以用请求头里的 API Key，也可以在桌面端加密保存 API Key。
- 历史导入：支持导入 DeepSeek Usage 页面导出的 CSV/ZIP。
- 登录态同步：可在本机窗口打开 DeepSeek Usage 页面，自行登录后同步用量。
- 浏览器插件：仓库根目录也可以作为 Chrome/Edge Manifest V3 插件加载。

## 环境要求

- Git
- Node.js 22.12 或更新版本
- npm 10 或更新版本
- Windows、macOS 或 Linux 桌面环境

检查本机版本：

```powershell
node -v
npm -v
git --version
```

## 快速开始

```powershell
git clone https://github.com/keepgoingzhx/Deepseek_Monitor.git
cd Deepseek_Monitor
npm install
npm start
```

启动后会打开桌面窗口，并自动启动本地接口：

```text
http://127.0.0.1:8787
```

如果你的网络环境下载 Electron 较慢，可以先配置 npm 镜像后再安装依赖。

## 第一次使用

1. 启动桌面端：`npm start`
2. 打开设置区域，按需填写 DeepSeek API Key。
3. 如果勾选“记住 API Key”，Key 会保存在本机；系统支持加密时会使用 Electron `safeStorage` 加密保存。
4. 将你的 DeepSeek 请求发到本地接口，例如 `/api/deepseek/chat/completions`。
5. 桌面窗口会自动累计响应里的 token 用量。

你也可以不保存 API Key，而是在每次请求里传入：

```text
Authorization: Bearer sk-your-key
```

## API 用法

### 转发聊天请求并记录用量

PowerShell 建议使用 `curl.exe`，避免和 PowerShell 的 `curl` 别名冲突：

```powershell
curl.exe http://127.0.0.1:8787/api/deepseek/chat/completions `
  -H "Authorization: Bearer sk-your-key" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

macOS/Linux：

```bash
curl http://127.0.0.1:8787/api/deepseek/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hello"}]}'
```

如果请求是流式请求，本地接口会自动补上：

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

### 查询累计用量

```powershell
curl.exe http://127.0.0.1:8787/api/deepseek/usage
curl.exe "http://127.0.0.1:8787/api/deepseek/usage?date=2026-05-10"
curl.exe "http://127.0.0.1:8787/api/deepseek/usage?from=2026-05-01&to=2026-05-10"
```

### 查询余额

```powershell
curl.exe http://127.0.0.1:8787/api/deepseek/balance `
  -H "Authorization: Bearer sk-your-key"
```

## 单独启动接口

如果只需要本地接口、不需要桌面窗口：

```powershell
npm run api
```

可以通过环境变量配置：

```powershell
$env:DEEPSEEK_API_KEY="sk-your-key"
$env:PORT="8787"
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
npm run api
```

如果设置了 `DEEPSEEK_API_KEY`，请求时可以不再传 `Authorization` 请求头。

## 在客户端中接入

如果你的客户端支持 OpenAI-compatible API，可以把 base URL 设置为：

```text
http://127.0.0.1:8787/api/deepseek
```

然后照常使用 `/chat/completions`。API Key 可以继续放在客户端请求头中，也可以先保存在桌面端。

## 加载浏览器插件

浏览器插件不需要构建，可以直接加载仓库根目录：

1. 打开 Chrome 或 Edge。
2. 进入 `chrome://extensions` 或 `edge://extensions`。
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本仓库目录 `Deepseek_Monitor`。

插件可以导入 CSV 并查看每日用量，也可以用 API Key 查询余额。桌面端是推荐的主要使用方式。

## 导入历史用量

不要把 DeepSeek 账号密码发给任何人。桌面端设置面板里的“网页登录”会打开 DeepSeek 官方 Usage 页面，你在本机窗口里自行登录。

登录后点击 DeepSeek 页面里的导出按钮。如果下载的是 CSV 或 ZIP，本工具会自动接收并导入；你也可以在桌面端手动选择 CSV/ZIP 文件导入。

## 本地数据与安全

- 本地接口只监听 `127.0.0.1`，不会对局域网开放。
- 浏览器跨域请求只允许来自 `localhost`、`127.0.0.1` 或 `::1` 的页面。
- `.local/` 会保存纯 API 模式的本地用量数据。
- Electron 桌面端数据保存在系统的应用数据目录中。
- API Key 不会上传到本项目作者或第三方服务器，只用于请求 DeepSeek 官方 API。
- `.local/`、`.env*`、CSV/ZIP 导出文件和 `node_modules/` 已加入 `.gitignore`。

## 常见问题

### 端口被占用

桌面端可以在设置里修改端口。纯 API 模式可以这样启动：

```powershell
$env:PORT="8788"
npm run api
```

### 余额查询失败

请检查 API Key 是否有效，或者确认请求里已经带上：

```text
Authorization: Bearer sk-your-key
```

### 用量没有变化

请确认模型请求是通过本地接口发出的，而不是直接请求 `https://api.deepseek.com`。只有经过本地接口的响应才会被统计。

### 安装依赖失败

建议先确认 Node.js 版本至少为 22.12。然后删除 `node_modules` 后重新安装：

```powershell
npm install
```

## 开发

运行检查：

```powershell
npm run check
```

该命令会检查主要 JavaScript 文件语法，并运行用量解析与代理相关测试。

## 项目结构

- `src/usage-api-core.js`：本地接口核心。
- `usage-api.js`：纯接口启动入口。
- `src/main.js`：Electron 主进程。
- `src/preload.js`：Electron preload 桥接。
- `desktop/index.html`、`desktop/renderer.js`、`desktop/styles.css`：桌面端界面。
- `usage.js`：CSV 解析和历史用量聚合。
- `popup.html`、`popup.js`、`manifest.json`：浏览器插件。
- `tests/usage.test.js`：基础测试。

## License

MIT
