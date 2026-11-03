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
- **`helper/` 里两个迁移脚本**：把 DurinDoor 的
  SQLite `providerConnections`、以及 xiaohuanxiong2api 的 `accounts.json`，
  转写成 magpie 的 `plugin-auth.json`，账号原样搬过来，不用重新登录、不碰
  厂商接口。两者都零依赖（`node:sqlite`、`node:crypto`，Node 22.5 起），
  都支持 `--dry-run` 与 `--install`。
