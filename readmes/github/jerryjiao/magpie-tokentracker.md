# magpie-tokentracker

[![npm version](https://img.shields.io/npm/v/magpie-tokentracker)](https://www.npmjs.com/package/magpie-tokentracker)
[![License: MIT](https://img.shields.io/github/license/jerryjiao/magpie-tokentracker)](./LICENSE)
[![node](https://img.shields.io/node/v/magpie-tokentracker)](https://www.npmjs.com/package/magpie-tokentracker)

在 magpie 窗口里追踪本机 [TokenTracker](https://github.com/xiufengsun/TokenTracker) 的 AI 用量：今天 / 7 天 / 30 天的 token 用量、花费、缓存命中、会话数，按编程工具和模型拆分，带小时级与每日趋势；另有订阅配额、近一年活动热力图、成就徽章，以及官方账号 / 云同步入口。零依赖。

![本机看板截图（深色）](docs/screenshots/dashboard-dark-today.png)

## 安装（发布后，从 npm）

npm 包发布后，一条命令安装：

```sh
magpie plugin add magpie-tokentracker
```

> 截至本文更新，npm 包尚未发布。当前本地开发安装方式见下文[「本地安装（开发中）」](#本地安装开发中)。

## 结构

```
index.mjs            magpie 宿主入口：server(input, options)，懒启动服务
server.mjs           零依赖 node:http 服务（只绑 127.0.0.1）
lib/usage.mjs        纯函数：周期换算、卡片/拆分/序列整理
lib/tokentracker.mjs TokenTracker 探活、自动拉起、API 调用
page/index.html      magpie 托管的带路页（bridge → 导航到本机服务）
page/boot.js         读 bridge（语言/主题/端口/magpie.service）后跳转
page/board.html|app.js|style.css   看板本体（服务端拼成全内联单页，见「注意」）
test/*.test.mjs      28 个测试（node --test）
test/fixtures/       从真实 TokenTracker 接口抓的样例
docs/                设计规范、发布文档（不进 npm 包）
```

## 本地安装（开发中）

```sh
magpie plugin add /Users/mac/Documents/projects/magpie-tokentracker
```

装完后 magpie 窗口侧栏的 Plugins 组里出现「TokenTracker」页。

**本地路径安装的坑（2026-11-17 白屏事故）**：magpie 的页面文件（`magpie.page.file`）只从插件库 `~/.config/magpie/plugins/node_modules/<name>/` 下发；`plugin add <本地路径>` 只注册 spec、执行服务代码，但不拷 page 文件 → 页面 tab 永远白屏（服务其实是活的）。本地开发二选一：

```sh
# A. 软链进插件库（本机用的就是这种）
ln -sfn "$PWD" ~/.config/magpie/plugins/node_modules/magpie-tokentracker

# B. 发 npm 包后 `magpie plugin add magpie-tokentracker`
```

装完（或第一次建好软链后）**要重启 magpie app**：桌面 app 只在启动时索引插件库，不重启它认不到新 page。验证：重启后 app.log 里出现 `plugin: [magpie-tokentracker] board on ...`。

## 依赖

本机要有 TokenTracker 在 `127.0.0.1:7680`（官方 CLI 的 `serve`）。没有也没关系：服务第一次被问到用量时会自动拉起（见下面的选项），拉不起来时页面显示离线提示和命令。

```sh
npx tokentracker serve        # 或 tokentracker serve
```

## 选项（magpie → Plugins → TokenTracker 的 options）

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3491` | 看板服务的端口（`0` = 随机，测试用） |
| `tokentrackerPort` | `7680` | TokenTracker 的端口 |
| `autoStart` | `true` | 探活失败时自动 `spawn` TokenTracker |
| `command` | `""` | 拉起用的命令；空 = PATH 里的 `tokentracker`，再退到 `npx -y tokentracker-cli` |
| `timeZone` | `""` | 「今天」的时区；空 = `Asia/Shanghai` |

环境变量同名大写（`MAGPIE_TOKENTRACKER_PORT` 等）也能喂，手动跑服务时方便。

## 服务接口（全部只读，只对 127.0.0.1 开）

| 路由 | 说明 |
|---|---|
| `GET /` | 看板 HTML（全内联单页；CSP `unsafe-inline` + 显式回环 connect-src，见「注意」） |
| `GET /api/usage?period=today\|7d\|30d[&force=1]` | 整理好的 JSON：卡片、按工具、按模型、小时/日序列 |
| `GET /api/status` | 服务端口 + TokenTracker 探活结果 |
| `GET /api/healthz` | 存活检查 |

- 数据 8 秒缓存，`force=1` 跳过；同周期并发请求合并。
- TokenTracker 不在时回 503，payload 里带 `hint.command`；自动拉起失败后有 60 秒冷却，避免每 20 秒的自动刷新反复 spawn。
- magpie 的页面 frame 是 opaque origin（`Origin: null`），所以 `/api/*` 对它回 `Access-Control-Allow-Origin: null`；其它 Origin 一律 403。数据本身不是秘密（TokenTracker 自己的读接口就是回环裸奔的），不加鉴权。
- 拉起的 TokenTracker 用独立进程组（`detached: true`），服务退出时整组 SIGTERM，不留孤儿占着 7680。

## TokenTracker 接口约定（实测 1.5.22）

- `GET /api/local-auth` → 探活 + 版本。
- `tokentracker-usage-summary?from&to&tz&rolling=1`：总量、花费、缓存、会话、`rolling.last_7d/last_30d`。
- `tokentracker-usage-daily` / `-usage-hourly`：日/小时序列。
- `tokentracker-usage-model-breakdown`：按工具（source）→ 模型的拆分和定价。
- 花费不在 `queue.jsonl` 里，是按定价表算的，所以必须走 HTTP 接口，不能直接读文件。

## 官方云同步与排行榜（可选）

看板之外，[TokenTracker](https://github.com/xiufengsun/TokenTracker) 官方还提供两项云上能力：

- **全球排行榜**：登录官方账号即可参加，免费。
- **官方 Cloud 云同步**（付费，[tokentracker.cc/cloud](https://tokentracker.cc/cloud)）：多设备用量聚合与网页历史。

本插件看板会显示官方账号的登录状态与对应入口；不登录也不影响本地功能——看板的全部本地能力（读取、展示、按工具/模型拆分、趋势）只走本机回环接口，不需要任何账号。

## 常见问题

### 本机没装 TokenTracker，怎么办？

不用提前装。服务第一次被问到用量时会探活 `127.0.0.1:<tokentrackerPort>`（默认 7680）；失败且 `autoStart` 开着（默认开）就自动拉起：优先 PATH 里的 `tokentracker`，退到 `npx -y tokentracker-cli`，都可以用 `command` 选项自定义。拉不起来时页面显示离线提示和可直接复制的命令；拉起失败后有 60 秒冷却，避免自动刷新反复 spawn（细节见「依赖」「选项」「服务接口」三节）。

### 没登录官方账号？

本地看板全功能可用——它只读本机 TokenTracker 的回环接口，不需要任何账号。网页历史、全球排行榜、官方 Cloud 云同步（付费）才需要登录官方账号：在官方看板 Settings → Account 里登录，或执行 `tokentracker device-login`。

### 数据上传了什么？

插件看板本身不向任何地方上传数据——它只读本机 TokenTracker 的回环接口。这些接口暴露的也只是聚合用量数字：tokens 数、按定价表估算的费用、模型名、编程工具名、小时/日时间桶，不含任何代码、提示词、对话内容或文件内容（见「TokenTracker 接口约定」）。只有当你主动使用官方 Cloud 云同步（付费）时，数据才会同步到官方云端，内容同样是用量数字，不是代码与对话。
<!-- TODO(发布前): 到 TokenTracker 官方仓库（https://github.com/xiufengsun/TokenTracker）核对官方隐私说明的准确表述与链接后，替换本行。 -->

## 开发

```sh
npm test                      # node --test test/*.test.mjs
node index.mjs                # 手动跑服务（默认 3491），Ctrl-C 会带走拉起的 TokenTracker
open http://127.0.0.1:3491/
```

改完代码要再 `magpie plugin add <路径>` 一次，magpie 的 Bun 宿主才会重新加载（宿主进程 magpie-bu 会换 pid）。

发布流程（GitHub repo / npm publish / magpie 收录）见 [`docs/publish-checklist.md`](./docs/publish-checklist.md)。

## 注意

- TokenTracker CLI 第一次 `serve` 会做初始化：给 Claude Code 写 hooks、改 Codex CLI 配置、装 Opencode 插件。都是可逆的，但要知情。
- 端口 3491 是挑过的：magpie 里 loop-guard 插件占了 3477/3478，避开。
- 端口被占时不再硬失败（magpie 自升级交接的真实事故修出来的）：同款服务连续两次探活成功 → 复用；否则每秒重试绑定，最多 20 秒，等旧实例退出；外来占用者等满 20 秒才报错。`/api/healthz` 带指纹 `{service, build}`（复用按服务名判，不按 build —— 多实例共存的稳定优先；升级代码后想让老 build 退位，`magpie plugin rm <路径> && magpie plugin add <路径>` 走一遍，宿主整个换进程）。
- 已知边界：同一台机器同时跑桌面 app 和 `magpie web` 时，第二个实例会复用桌面侧的服务（同款指纹），页面照常跳本机服务。
- 看板是全内联单页（服务端把 style.css/app.js 内联进 board.html，并把 `__SERVICE_BASE__` 注入成 `http://127.0.0.1:<port>`）：magpie 的页面 frame 是 `sandbox="allow-scripts"` 的 opaque origin，CSP 里 `'self'` 匹配不到任何来源，外链 css/js 和相对 fetch 全会被拦；所以 CSP 用 `'unsafe-inline'` + 显式回环 connect-src，fetch 一律走绝对地址。
- 改了 `server.mjs` 记得 `BUILD` +1（healthz 里看得见）；改了 page 文件不用，内联是每次请求现拼的。

## License

[MIT](./LICENSE)
