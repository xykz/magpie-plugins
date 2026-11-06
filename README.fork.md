# What this fork adds

This is a fork of
[magpie-community/plugins](https://github.com/magpie-community/plugins). The
packages themselves, how to write one, and how publishing works are described
in upstream's [README.md](README.md) and in each package's own `README.md` —
this fork leaves all of them exactly as upstream wrote them, so that a merge
from upstream never has to merge past a fork edit. What this fork adds on top
of them is written down here, in a file of its own.

Package versions are upstream's, too: this fork doesn't bump a `version` in
`packages/*/package.json`, so a package's number in this fork is always the
number upstream gave it. A fork-only change sits on the version upstream last
released, and the next upstream release carries it.

## `workbuddy`: the `requestFormat` option

A chat to the China build can go out in the shape of the official CodeBuddy
CLI, `@tencent-ai/codebuddy-code` 2.108.1, instead of WorkBuddy's own desktop
app. Its option is `requestFormat`:

    { "requestFormat": "codebuddy-2108" }

In magpie it is set from the plugin's row on the Plugins page (Installed ›
Options, which starts from the package's `magpie.options`), or in its
`plugins.json` entry; in OpenCode,
`["@magpie-community/opencode-workbuddy-auth", { "requestFormat": "codebuddy-2108" }]`.
The default, `"magpie"`, is the format every request used before the option
existed, and a value naming neither is read as `"magpie"`, so a typo sends
what every request sent before rather than failing a chat.

What changes — a 2.108.1 chat is nine headers and no more, which is what
DurinDoor v3.18.0's own `codebuddy-cn` executor puts on the wire (and that
request is the one checked against the gateway in production):

- `User-Agent: CLI/2.108.1 CodeBuddy/2.108.1`, `X-IDE-Type: CLI`,
  `X-IDE-Name: CLI` — the CLI's own naming of itself in place of the app's
  (`buildUserAgent()`, `CliClientInfoProvider`);
- the three it keeps from before: `X-Product: SaaS`, `x-codebuddy-request: 1`,
  `x-requested-with: XMLHttpRequest`;
- `Accept: text/event-stream`, because a chat there is always streamed;
- everything the app adds goes — `X-User-Id`, `X-Domain`, `X-API-Key`, the
  enterprise pair, `X-IDE-Version`, `X-Agent-Intent`, `X-Agent-Purpose`,
  `X-Private-Data`, `X-Agent-Type`, `X-Agent-Runtime`, and the whole
  `X-Stainless-*` set;
- magpie's own hint headers (`X-Magpie-Session`, `X-Magpie-Agent`) go too:
  they are the host's, meant for the plugin, and a request naming this host is
  not the 2.108.1 request this format copies. The session they carry is read
  off before they are taken off, so nothing the plugin does with it is lost;
- the four conversation ids go too: DurinDoor's request carries none, and it
  is the one checked against the gateway;
- the body is not gzipped: no CLI capture carries a `Content-Encoding`;
- the body is always streamed (`stream: true`), because the gateway answers
  `11101 Non-stream chat request is currently not supported` to one that
  isn't. A client that asked for the whole reply at once still gets it: the
  chunks are put back together into one `chat.completion`;
- `stream_options: {"include_usage": true}` is added when the client named
  none, and left as it wrote it when it did;
- `reasoning_effort: "none"`/`"off"` is deleted, not sent — the gateway has no
  such effort — and any other effort gains `reasoning_summary: "auto"` beside
  it, overwriting a caller's own. `verbosity` is never written. A chat that
  spells its effort `reasoning: {effort}` gains nothing, as there;
- `max_tokens`/`max_completion_tokens` follow the model: gpt-5.x and
  o1/o3/o4 take `max_completion_tokens`, everything else `max_tokens`, and an
  explicitly set destination field wins.

What does not change: the bearer token, the body's `model`, `messages`,
`tools` and sampling fields, and everything the plugin sends that isn't a
chat — the product config, the meter and the daily check-in are not chats, and
`/v1/messages` and count_tokens are another API whose headers no CodeBuddy
capture describes. WorkBuddy AI has the one format — the option is about the
China build's chat endpoint.

Where the fingerprint comes from: DurinDoor v3.18.0's
`open-sse/{registry,executors}/codebuddy-cn.js`, run and captured — the
request it actually sends, not a reading of the bundle. 2.108.1 is the release
it mirrors, and the reason to mirror that one rather than a later release is
that from 2.146.0 the CLI mints UUIDv7 conversation ids, whose first 48 bits
are a real creation timestamp, and later releases add headers and body fields
(`baggage` in 2.164.0, `cache_retention` and `extra_vars` in 2.172.1) that a
2.108.1-shaped request should not carry. `packages/workbuddy/format.test.mjs`
pins the plugin against that capture. The shape itself — the nine headers, the
body transform, the stream reassembly — is `packages/workbuddy/codebuddy.mjs`,
a file of its own so that following upstream's `index.mjs` never has to merge
past it.

## `raccoon`: its own User-Agent

magpie asks vendors with its own `magpie/<version>`, and a plugin can't take
that back (a plugin's provider has an account, so magpie's `user-agent`
setting and the provider's headers don't reach it). This plugin asks the chat
API as the OpenAI SDK does, `AsyncOpenAI/Python 2.8.0`, the way the desktop
app does. `RACCOON_USER_AGENT` overrides it; set it to an empty string to
leave magpie's own alone.

The one thing it does not change is the version it reports of itself:
`packages/raccoon/package.json` stays at upstream's `0.1.5`, because npm has
no published version of this package to compare it with and the fork doesn't
rename it.

## `raccoon`: the rest of the app's request

The User-Agent was the first half of a larger difference. The desktop app's
chat calls are not made by its JavaScript: the Electron build writes the config
out and a bundled CPython sidecar (`resources/box-agent-runtime/`) makes the
call with the `openai` 2.8.0 SDK over httpx. So the request is defined by
Python code inside a PyInstaller archive, and the plugin had been guessing at
it.

What the app sends that the plugin did not, now in
`packages/raccoon/vendor-wire.mjs`:

- **`X-Stainless-*`**, six headers, one of which nobody guesses right: the
  SDK's `platform_headers()` names `Windows`/`MacOS`/`Linux`, `CPython`,
  `3.12.13` (the interpreter the app bundles) — and for arch, `other:amd64` on
  a Windows x64 build, because `get_architecture()` maps `arm64`/`aarch64`,
  `arm` and `x86_64` and nothing else, while `platform.machine()` on Windows
  says `AMD64`. macOS and Linux name themselves normally.
- **`x-client-*`**, five headers, from the `ClientInfo` the app hands its
  sidecar over ACP: `@raccoon/office-desktop`, `official`, the app version as
  `v1.1.5`, the OS version, and `desktop-windows-x64` — a second spelling of
  the same machine, different from the SDK's next door. No device id is sent,
  because the app has none. A version that is not exactly three numbers costs
  that one header and nothing else; a non-ASCII name falls back to `raccoon`;
  and none of the five goes to any host but `xiaohuanxiong.com`
  (`RACCOON_CLIENT_HEADERS_HOSTS` adds hosts, for a relay).
- **`X-RACCOON-Session-ID`/`-Turn-ID`/`-Title`/`-Call-Kind`**, the turn
  headers. The plugin sees no session, so the session id is derived from the
  conversation's first message — the same one on every turn of it, which is
  what the app's own id does. `Call-Kind` is left off: the app's value comes
  from its ACP caller, `box_agent` itself contains no `chat` literal, so
  inventing one would be a guess — and an absent header is what the app sends
  when its caller passes nothing.
- **`X-Org-Code`**, from the auth record's `office_identity`: a team seat sends
  it, a personal one sends nothing, which is why its absence is the usual case.
- **`Accept-Encoding: gzip, deflate`**, httpx's own default, which Node's fetch
  would otherwise replace with `br`/`zstd`.
- **thinking, per model family.** This was the one real bug: the plugin wrote
  `extra_body.thinking.type` for every model. Only deepseek and doubao read
  that. qwen reads `enable_thinking`; kimi-k3 and the glm-5.3 pair take
  `reasoning_effort` and treat *off* as `low`, not `none`; gemini and gpt-6
  have models that must never be told "off" (`gemini-2.5-pro`,
  `gemini-3.1-pro`); a gpt-6 given function tools is told `none` regardless;
  and sensenova defaults to `none` except one measured model that defaults to
  `low`. The plugin only sees what the agent asked for, so a body with no
  thinking intent is left alone rather than given one.
- **`stream_options: {include_usage: true}`** on every stream.

Where these come from: not a reading of the app, but the app's own bytecode,
executed. `helper/raccoon-vendor-fixture.mjs` unpacks the asar and the
PyInstaller archive, and `helper/raccoon-vendor-fixture.py` runs
`platform_headers`, `ClientInfo.headers_for_url`, `_agent_headers` and
`_apply_thinking_params` out of it and prints what they return.
`packages/raccoon/testdata/vendor-desktop-1.1.5.json` is that output, and
`vendor-parity.test.mjs` pins the module against it. Regenerating needs
CPython 3.12 and the app's zip, neither of which CI has, so the JSON is
committed and `--check` is a local tool.

What cannot be matched, and is listed as such in `KNOWN_DIVERGENCES`: `host`
and `content-length` differ because a relay is not the app and the body is not
byte-identical. `Connection: keep-alive` is set the way httpx sets it; whether
a transport forwards a forbidden header is the transport's business (Bun does,
Node's undici does not), so it is not listed as a divergence.

## `loomy`: password sign-in, and the session it keeps alive

Loomy hands out no refresh token: a session lives 14 days and only signing in
again extends it. So the account's password is the only renewal credential
there is, and this fork adds a sign-in method that takes it, plus the renewal
that keeps a password account running unattended.

The sign-in is `账号密码登录（Password sign-in）`, beside the SMS one and the
pasted session. Phone number and password go in as prompts; `node:crypto`
seals the password to the public key `getPuKey` hands out (RSA PKCS#1 v1.5, no
dependency added) and `byPwd` answers a session. `rcode` is that call's nonce,
not a captcha, which is what makes the chain unattended — and therefore
renewable. Two things the upstream does that a strict decoder rejects are both
handled: the base64 `pukey` arrives without padding, and it may be an SPKI
`SubjectPublicKeyInfo` or a bare PKCS#1 `RSAPublicKey`.

The credentials are kept in the sign-in record's `refresh` field as
`{"loginid","password"}` — that is the field magpie reads as an oauth
account's secret (`host.js` `secretOf`), and where this repo already carries
multi-part credentials (`zcode`'s `refresh: JSON.stringify(state)`, `mimo`'s
the same). They land in `plugin-auth.json`, mode 600, **plaintext: not an
encrypted vault** — the same trust model as a browser's saved passwords. SMS
sign-ins and pasted sessions carry no password and behave exactly as before.

Renewal runs on both paths, because the hosts differ:

- magpie calls `auth.refresh` with `auth.refreshLead` set, so it renews once
  per account 3 days before the end (`loomy2api`'s `session_renew_before_days`
  default is the same 3). Failures throw rather than return undefined: the
  host records its `RENEW_RETRY` cooldown only when this throws, and
  `undefined` would have it retry the same doomed call on every hook until
  the session expired on its own.
- OpenCode never calls `auth.refresh`, so the loader's `fetch` renews itself:
  a 401/403 signs in again and the request goes once more, answered with
  `X-Magpie-Sign-In: renewed`. `usage` and `checkin` are wrapped the same way.

A vendor refusal and a transport failure are kept apart. HTTP 200 with a
business code that is not `000000` is the vendor saying no on purpose — that
marks the sign-in lapsed (`signIn: "expired"`, or `X-Magpie-Sign-In: expired`).
A network error or a 5xx is no verdict on the password and leaves the account
as it was (`kept`). A renewal already made in this process is reused unless
the caller is holding that very session, which was just refused.

All of it is `packages/loomy/renew.mjs`, which `index.mjs` reaches in four
places — an import, a `loomyRenewal()` call, `return extendLoomy(renewal.extend({`,
and the closing `}))` — so that following upstream's `index.mjs` never has to
merge past the new code: `extend()` mounts `refreshLead`/`refresh` and wraps
`loader`/`usage`/`checkin` itself, so an upstream rewrite of those hooks is
wrapped rather than lost. The shape of the file split follows
`packages/workbuddy/codebuddy.mjs`.

The second fork-only file is `packages/loomy/extras.mjs`: Loomy's client tells
its own gateway that the eight onboarding tasks are done and is paid for
saying so, and this fork sends the same eight `POST
/api/v1/onboarding/tasks/complete` calls (one body field, `{"key": …}`, 10000
points in all) inside the first check-in after sign-in — serially, in the
client's order, once per account. Which keys an account has already been paid
for is kept in `$XDG_CONFIG_HOME/magpie/loomy-onboarding.json` (or
`LOOMY_ONBOARDING_LEDGER`), keyed by account id, mode 600; `LOOMY_ONBOARDING=0`
turns the whole thing off, and a check-in whose own answer was anything but a
claim pays nothing. The same file adds the `traceparent` and `loomy-version`
pair, on the chat request.

`package.json`'s `files` gains `renew.mjs` and `extras.mjs`, since an install
that left either out would have a plugin that cannot import.

## `helper/`: carrying sign-ins in from other tools

Both scripts read another tool's store and write magpie's
`plugin-auth.json` — the OpenCode `auth.json` shape magpie's plugin host
reads — so an account moves across as it is: no re-login, no vendor round
trip. Both are zero-dependency (`node:sqlite` and `node:crypto`, Node 22.5 or
later) and both take `--dry-run` and `--install`.

- `helper/durindoor-to-magpie.mjs` — DurinDoor's SQLite `providerConnections`,
  whose credential columns are AES-256-GCM under `<DATA_DIR>/master-key`.
- `helper/xiaohuanxiong2api-to-magpie.mjs` — xiaohuanxiong2api's
  `accounts.json`, for the `raccoon` plugin: the same vendor, the same
  credentials, a different shape.

## 中文

本仓库是 [magpie-community/plugins](https://github.com/magpie-community/plugins)
的 fork。上游的 `README.md` 与各软件包自己的 `README.md` 一律保持上游原样，
不做改动，这样从上游合并下来时不会撞上 fork 的编辑。fork 自己的增补只写在
这个文件里。

版本号同样是上游的：fork 不改 `packages/*/package.json` 里的 `version`，
所以这里的版本号永远等于上游发的那一个；fork 独有的改动挂在上游最后发布的
版本上，由下一个上游发布带走。

- **`workbuddy` 的 `requestFormat` 选项**：可以按官方 CodeBuddy CLI
  （`@tencent-ai/codebuddy-code` 2.108.1）的形状，而不是桌面客户端的形状，
  向中国版发对话请求。取值 `"codebuddy-2108"`，默认 `"magpie"`（即该选项
  出现之前每个请求的形状），写了不认识的值也按 `"magpie"` 处理。九个请求头、
  不压缩、强制流式并把分片拼回一个完整回复、`reasoning_effort` 的处理、
  `max_tokens`/`max_completion_tokens` 按模型区分，细节见上一节；形状本身在
  `packages/workbuddy/codebuddy.mjs`，`packages/workbuddy/format.test.mjs`
  把它钉在真实的抓包上。
- **`raccoon` 自带 User-Agent**：magpie 默认以自己的 `magpie/<version>` 请求
  上游，插件无法从 provider 侧改掉它（插件 provider 恒有 account，magpie 的
  `user-agent` 设置和 provider 的 headers 都到不了这里）。本插件按桌面端的
  做法，以 OpenAI SDK 的 `AsyncOpenAI/Python 2.8.0` 请求对话接口；环境变量
  `RACCOON_USER_AGENT` 可覆盖，设为空字符串则沿用 magpie 自己的。
- **`raccoon` 请求的其余部分**：User-Agent 只是差异的一半。桌面端的对话请求
  不是它的 JavaScript 发的——Electron 把配置写出去，由打包进应用的 CPython
  侧车（`resources/box-agent-runtime/`）用 `openai` 2.8.0 SDK 经 httpx 发出。
  也就是说请求形状由 PyInstaller 归档里的 Python 代码决定，而插件此前一直在
  猜。现在这些实现在 `packages/raccoon/vendor-wire.mjs`：SDK 的六个
  `X-Stainless-*`（其中架构一项没人猜得对——Windows x64 上 SDK 报
  `other:amd64`，因为 `get_architecture()` 只映射 `arm64`/`aarch64`、`arm`、
  `x86_64`，而 Windows 的 `platform.machine()` 说 `AMD64`）；五个
  `x-client-*`（`@raccoon/office-desktop`、`official`、`v1.1.5`、系统版本、
  `desktop-windows-x64`——同一台机器的第二种拼法，与紧邻的 SDK 不一样；不发
  device id，因为应用没有；版本号不是严格三段式时只丢那一个头；非 ASCII 名字
  回落 `raccoon`；且这些只发给 `xiaohuanxiong.com`，`RACCOON_CLIENT_HEADERS_HOSTS`
  可为中继放行）；四个 `X-RACCOON-*` 轮次头（插件没有 session，会话 id 由对话
  首条消息推导，同一对话每轮相同，与应用自己的 id 行为一致；`Call-Kind` 不发，
  因为它的值来自应用的上游调用方，`box_agent` 里根本没有 `chat` 字面量，凭空
  写一个就是猜，而调用方不传时应用也不发这个头）；`X-Org-Code`（取自 auth 记录
  的 `office_identity`，团队席位发、个人席位不发，所以它缺席才是常态）；
  `Accept-Encoding: gzip, deflate`（httpx 的默认值，Node 的 fetch 否则会换成
  `br`/`zstd`）；**按模型分族的 thinking**——这是唯一一个真 bug：插件过去对所
  有模型都写 `extra_body.thinking.type`，但只有 deepseek 和 doubao 读它；qwen
  读 `enable_thinking`；kimi-k3 与 glm-5.3 那对收 `reasoning_effort`，且「关」
  是 `low` 而不是 `none`；gemini 与 gpt-6 里有不能被告知「关」的模型
  （`gemini-2.5-pro`、`gemini-3.1-pro`）；带 function 工具的 gpt-6 一律
  `none`；sensenova 默认 `none`，只有一个实测模型默认 `low`。插件只看得到
  agent 写在 body 里的意图，所以没有 thinking 意图的 body 原样放过，而不是替它
  编一个；以及每个流式请求的 `stream_options: {include_usage: true}`。
  这些值的来源不是读代码，而是跑应用自己的字节码：
  `helper/raccoon-vendor-fixture.mjs` 解开 asar 与 PyInstaller 归档，
  `helper/raccoon-vendor-fixture.py` 从里面执行 `platform_headers`、
  `ClientInfo.headers_for_url`、`_agent_headers`、
  `_apply_thinking_params` 并打印返回值，
  `packages/raccoon/testdata/vendor-desktop-1.1.5.json` 就是那份输出，
  `vendor-parity.test.mjs` 把模块钉在它上面。重新生成需要 CPython 3.12 与
  应用的 zip，CI 两者都没有，所以 JSON 入库、`--check` 是本地工具。
  无法对齐的两项记在 `KNOWN_DIVERGENCES`：`host` 与 `content-length` 不同，
  因为中继不是应用、body 也不是逐字节相同；`Connection: keep-alive` 则按 httpx
  的默认值照发，只是 fetch 会不会转发禁用头由传输层决定（Bun 会，Node 的
  undici 不会），因此不算插件主动的偏差。
- **`helper/` 里两个迁移脚本**：把 DurinDoor 的
  SQLite `providerConnections`、以及 xiaohuanxiong2api 的 `accounts.json`，
  转写成 magpie 的 `plugin-auth.json`，账号原样搬过来，不用重新登录、不碰
  厂商接口。两者都零依赖（`node:sqlite`、`node:crypto`，Node 22.5 起），
  都支持 `--dry-run` 与 `--install`。
- **`loomy` 的密码登录与自动续登**：Loomy 没有 refresh token，session 只有
  14 天，唯一能续期的凭据是账号密码，所以本 fork 加了第三种登录方式
  「账号密码登录（Password sign-in）」，并用它让密码账号无人值守地活下去。
  手机号与密码作为 prompt 输入，`node:crypto` 把密码封进 `getPuKey` 当场
  下发的 RSA 公钥（PKCS#1 v1.5，不引入依赖），`byPwd` 换回 session
  （`rcode` 是服务端 nonce 不是验证码，因此全程可自动化，也才可续期；公钥
  base64 缺 padding、以及 SPKI 与裸 PKCS#1 两种 DER 都兼容）。凭据以
  `{"loginid","password"}` 存进签入记录的 `refresh` 字段（magpie 把 oauth
  账号的 `refresh` 当作 secret，`zcode`/`mimo` 也把多段凭据放这里），落在
  `plugin-auth.json`（权限 600），**明文，不是加密保险库**——与浏览器保存
  密码同一级别的信任模型；短信与粘贴 session 的账号没有密码，行为不变。
  续登走两条路：magpie 在到期前 3 天调 `auth.refresh`（对齐 `loomy2api` 的
  `session_renew_before_days` 默认值）且**失败必须 throw**（否则宿主不会记
  `RENEW_RETRY` 冷却，会在每个钩子上重试同一个必败的调用）；OpenCode 不调
  这个钩子，所以 loader 的 `fetch`、`usage`、`checkin` 自己在 401/403 时
  重登一次并重发，响应带 `X-Magpie-Sign-In: renewed`。厂商明确拒绝（HTTP
  200 + 非 `000000`）才标记登出（`expired`），网络错误与 5xx 只 `kept`。
  代码全在 `packages/loomy/renew.mjs`，`index.mjs` 只动四处（import、
  `loomyRenewal()`、`return extendLoomy(renewal.extend({`、收尾 `}))`），
  `extend()` 自己挂 `refreshLead`/`refresh` 并包住 `loader`/`usage`/`checkin`，
  所以上游重写这些钩子时会被包住而不是丢失——文件拆分方式与
  `packages/workbuddy/codebuddy.mjs` 一致。另一个 fork 独有文件是
  `packages/loomy/extras.mjs`：Loomy 客户端会自己向网关声明八个新手任务已完成
  并因此拿到积分，本 fork 在登录后的首次签到里照发同样的八条
  `POST /api/v1/onboarding/tasks/complete`（body 只有一个 `{"key": …}`，合计
  10000 分），串行、按客户端顺序、每个账号只发一次；已领过哪些 key 记在
  `$XDG_CONFIG_HOME/magpie/loomy-onboarding.json`（或 `LOOMY_ONBOARDING_LEDGER`），
  按账号 id 分键，权限 600；`LOOMY_ONBOARDING=0` 可整体关闭，签到本身没领到
  的那次不发礼包。同一个文件还加了客户端每次请求都带的 `traceparent` 与
  `loomy-version`。`package.json` 的 `files` 加了 `renew.mjs` 与
  `extras.mjs`。
