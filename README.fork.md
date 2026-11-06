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

### The request headers are the client's — a third fork-only file

`packages/loomy/headers.mjs` rebuilds what Loomy's own 0.9.39 client puts on
the wire. That is not decoration: the plugin reaches the same gateway the
desktop app does, and a request that identifies itself differently is
distinguishable from the app's.

The evidence is the client's own traffic. The app ships an LLM debug proxy
(`electron/llm/llm-debug-proxy.js`, switched on by `LOOMY_LLM_DEBUG_PROXY=1`)
that records every completion verbatim; those recordings are in
`.sandbox/loomy-captures/real-windows*/`, and the shipped sources were read out
of `app.asar` beside them. Where a value could not be confirmed it is absent
rather than invented.

What the captures settled, and what changed because of them:

- **Auth is per plane.** The chat plane carries `Authorization: Bearer <session>`
  and *no* `token` header; the catalog, the two points paths and onboarding
  carry `token` and no `Authorization`; the draw path carries both. The plugin
  used to send both everywhere.
- **`Content-Type` carries no charset.** The client sends bare
  `application/json` — CJK in the body and all — and the vendor answers 200.
  The plugin's `;charset=utf-8`, with a comment claiming the upstream reads GBK
  without it, was not load-bearing and was itself a tell.
- **`Accept` differs by path**: `*/*` on chat (that is opencode's, through
  `@ai-sdk/openai-compatible`), `application/json` on the catalog and on a draw.
- **The attribution headers exist**: `chatid` (a UUIDv4 stable per session),
  `msgid`/`turnid` (the same value, per request), `invokeorigin` (`user` or
  `system`), `x-loomy-request-purpose`, and `x-session-affinity` (the harness's
  session id). magpie hands a plugin the session as `X-Magpie-Session`, so the
  chatid is derived from it: stable across a conversation, and shaped like the
  client's rather than like magpie's `magpie-<sha256>`.
- **`x-session-affinity` is the caller's id only when it could be opencode's.**
  A plugin cannot choose who calls it, and magpie forwards whatever session the
  agent named (`internal/gateway/gateway.go` `sessionOf`, nine header names), so
  the value may be opencode's `ses_…`, Claude Code's `cc-…`, a bare uuid, or
  nothing. All 8 captured requests carry `ses_` + 12 hex + 14 base62 — 30
  characters, opencode's own layout, which magpie mints the same way
  (`internal/provider/opencode_client.go`) and tests with a small low counter.
  So a value of that shape goes through untouched, and anything else is derived
  into that shape rather than passed on. Passing it on would name the caller
  (`cc-…` is a shape no Loomy client emits) *and* let a non-ASCII value kill the
  request locally: `new Headers()` throws on one, which the loader surfaced as a
  502 before anything was sent. Nothing has to be mapped back — the vendor
  echoes no session id at all (its response headers are
  `server`/`date`/`content-type`/`transfer-encoding`/`connection`/`cache-control`,
  its SSE ids are its own `cht…@dx…`), and the client's own bundle has no
  `x-session-affinity` string in it: it sends the value, never reads it back.
- **Two user agents, not one.** The gateway plane is reached through opencode,
  the account domain through axios; the captured strings are
  `opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13` and
  `axios/1.21.0`. magpie runs a plugin under bun with no UA flag, so without
  this every call would announce `Bun/1.4.2`.

Two things are deliberately *not* the client's, and both are written down where
they are set: the purpose is always `chat.message` (a plugin cannot tell a chat
from a title generation or a memory extraction; the client has 17 values —
`chat.message`, `chat.title`, `pet.comment`, `pet.reward`, `kb.vision`,
`kb.audio`, `kb.summary`, `kb.embed`, `search.web`, `image.generate`,
`assistant.completion`, `assistant.asr-correct`, `memory.extract`,
`memory.recall`, `memory.dream`, `skill.evolution`, `skill.curator` — recorded
here rather than as a set in the code, because nothing in the plugin can ever
choose one), and the UA is a pinned literal rather than something discovered,
because magpie does not tell a plugin which opencode it runs under.
`LOOMY_CLIENT_UA` and `LOOMY_ACCOUNT_UA` override both.

The same captures killed a body rewrite. The plugin used to turn a DeepSeek
image part into a `<image_base64>…</image_base64>` text marker; the client sends
a plain `image_url` part and the model reads it (measured: four parts in one
user message, vendor 200, the model describing the screenshot). Replaying all
eight captured bodies through the loader now returns each one byte for byte —
`tools/replay-real.mjs` checks it, `tools/gen-table.mjs` reports it.

One consequence worth stating plainly: `packages/loomy/README.md` is left as
upstream wrote it, so its chat bullet still claims the old shape — that
`charset=utf-8` is required ("without it the upstream reads GBK") and that
DeepSeek images become `<image_base64>` markers. Both are now false. The rule at
the top of this file is what keeps it that way; this paragraph is where the
correction lives instead.

One thing this does *not* establish. `packages/loomy/fake.mjs` now enforces the
same per-plane split the captures show, so the suite fails if the plugin drifts
back to sending both credentials everywhere. A green run therefore means the
plugin matches the captures — not that the real gateway requires the split. The
client proves the new shape is accepted; nothing proves the old one is refused.
That is what a live run on a real account is for.

`package.json`'s `files` gains `headers.mjs` too.

### What the public ports say, and where they are not the client

Four public repos carry a Loomy client (`xxhhlk`, `Patrick130306`,
`xingluoyuankong` — the last two share their header builder line for line — and
`Buddy2api`, which is a seven-channel gateway rather than a `loomy2api` fork).
They are useful as a second opinion on *field names*, and they are not a second
opinion on *client behaviour*: each one is a gateway that has to make the
upstream **accept** a request, so its header builder sends the union of
everything accepted rather than the subset the client actually sends.

`Buddy2api` is worth naming separately because it is the only one of the four
that writes `X-Loomy-Request-Purpose` itself rather than forwarding it, and it
still gets the plane wrong in the same direction: one `model_headers()` serves
chat, `/models` and `/points/records` alike, with `Accept: application/json`
and a hard-coded `purpose="chat.message"` even on the points read. It also
invents a per-account device id (`devid = "web-<16 hex>"` where the client's
`_makeBase()` sends the constant `"web"`), skips the SMS sign-in entirely
(password only), and has no `/points/first-login` — its "claim" just reads
`dailyBalance` back and reports `already_claimed`. Two things it does
independently confirm: the same AK/SK pair this plugin decrypted out of
`.env.prod`, and the same nine-line string-to-sign in the same order. Its tests
use mocked upstreams ("上游与登录均使用模拟响应，未调用真实账号"), so it is not
evidence of live behaviour either.

Where they contradict the captures, the captures win:

| they send | the 0.9.39 client sends |
|---|---|
| `Authorization` **and** `token` ("session 模式双写") | `Authorization` only — `token` on 0 of 8 captured requests |
| `Accept: application/json` | `*/*` |
| no `User-Agent` of its own (stdlib `http.client`, or httpx's `python-httpx/…`) | `opencode/1.14.22 ai-sdk/provider-utils/…` |
| nothing for `ChatId`/`MsgId`/`TurnId`/`InvokeOrigin`/`X-Session-Affinity` unless the caller sets them | all five, on every request |

Their `X-Loomy-Request-Purpose` list of 17 is identical to ours, and their
`traceparent` / `loomy-version` shapes match, so those parts corroborate.

Two claims of theirs are wrong and were checked instead of copied:
- "`/models` declares `reasoning_efforts`, defaulting to `low`". The field does
  not appear in the client at all (`reasoning_efforts`,
  `default_reasoning_effort`, `reasoningEfforts`: 0 hits in the 231 MB
  `app.asar`, in a search where `useSessionAuth` returns 31). The client's
  picker is the fixed `low|medium|high`, default `medium`. Whatever the
  catalogue holds, the client does not read it.
- "`reasoning_effort` has no effect; only a `/no_think` prefix does". The client
  sends `reasoning_effort` and nothing else — `/no_think`: 0 hits in the client.
  That rewrite is for their own callers, not a client emulation.

Where they name a field we got wrong, they are right: the catalogue's output cap
is `max_output_tokens`, and the client's mapper reads
`limit.output → max_output_tokens → max_completion_tokens`. This plugin read
`max_tokens`, a spelling the catalogue never uses, so the output limit was empty
for every model discovered live and only the hard-coded `STATIC_MODELS` numbers
ever showed. `Buddy2api`'s `capacity_fields()` is a fourth independent reading of
the same names. Fixed, with the fake serving the catalogue's real spelling.

## `raccoon` and `loomy`: how often the vendor's non-chat endpoints are read

magpie polls a plugin account's allowance on clocks it owns, and none of them
is a user's click. In `internal/provider/routing.go` (`Allowances`) an account
in a group with chat traffic is re-read once a minute per agent; the tray reads
every `TrayUsageEvery` minutes (`internal/settings/settings.go`, default 3);
the Usage page reads while it is open; and `internal/provider/checkin.go` wakes
every minute, re-asking the day's check-in every 30 minutes
(`wbCheckinEvery`) for as long as the account's answer does not say when it
stops being true. A hook is handed no sign of which of those asked
(`infoOf`, `internal/plugin/host.js`: id, name, source, env, options, npm,
api, … — no "why"), so the only lever a plugin has is to answer once for
several asks.

That lever has a floor, which is why these numbers are what they are:
magpie's own host already caches a reading for a minute
(`cachedLoginReading`, `internal/provider/login_usage.go`), so any plugin TTL
at or below 60s cuts nothing. And because the host's cache sits in front of the
plugin, `refreshCards`/`forgetLoginReading` cannot reach through it — a user's
刷新 can be answered from the plugin's reading. Three minutes was chosen as the
shortest TTL that is a real cut and still short enough that a hand-pressed
refresh is not visibly stale.

- **`raccoon`**: `auth.usage` answers from one reading for
  `RACCOON_USAGE_TTL_MS` (default 180000), single-flighted per account, with a
  30-second negative cache so an endpoint answering 500 is not pressed every
  pass — a lapse (`signIn: "expired"`) is never cached. Inside that reading the
  two per-endpoint costs are cached separately because they move on different
  clocks: `RACCOON_ENTITLEMENT_TTL_MS` (default 6h, the plan changes a few
  times a year) and `RACCOON_BILLS_TTL_MS` (default 10min), while the balance is
  read every time. Because the balance is fresh and the ledger is not, a grant
  that lands mid-window shows up as `grantedFromBills < avail`; that answer is
  re-read once per bills TTL (`billsHealedAt`) rather than reported as a
  negative `used`. Caches are keyed by account, not by access token, so a
  renewal does not buy a second read. A check-in clears the account's reading,
  so the press is answered by what it just claimed.
- **`loomy`**: `auth.usage` the same way (`LOOMY_USAGE_TTL_MS`, default
  180000), and `provider.models` answers from one `GET /api/v1/models` for
  `LOOMY_MODELS_TTL_MS` (default 600000), keyed by base URL plus account (the
  endpoint is asked with the account's token, and nothing establishes that two
  accounts see the same list). A failed catalogue read is not remembered: the
  static table still answers and the next ask tries again.
- **both, check-in `until`**: a check-in answer now carries `until`, the next
  Beijing midnight, on every non-failed outcome (`claimed` and `done` alike;
  never on `failed`). The host parses it into `ValidUntil`
  (`internal/provider/plugin_checkin.go`) and `settled()`
  (`internal/provider/workbuddy_checkin.go`) then holds the answer until it —
  which is what suppresses the every-30-minutes re-ask, a rule that only
  applies while `ValidUntil.IsZero()` (`checkin.go`). A user pressing 签到 still
  re-asks (`if soon && prev.unclaimedAnswer() { settled = false }`), so this
  costs nothing. `raccoon`'s `done` is "nothing new in the bills yet", not
  "the vendor has not paid" — the ledger lags the grant — so it says when to
  ask again too. `loomy`'s check-in still reads the daily balance before and
  after the `first-login` POST: that pair is the only claimed-vs-done verdict
  the endpoint allows.

What this does not change: the chat path, any hook's answer shape, and every
read a user's own action makes necessary. `RACCOON_*_TTL_MS` /
`LOOMY_*_TTL_MS` set to `0` turns the corresponding cache off, which is what
the tests use.

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
- **`raccoon` / `loomy` 非对话接口的读取频率**：magpie 按自己的时钟轮询插件
  账号的额度，没有一次是用户点的——分组里有对话流量时 `Allowances`
  （`internal/provider/routing.go`）每分钟对每个 agent 重读一次，托盘每
  `TrayUsageEvery` 分钟（`internal/settings/settings.go`，默认 3），Usage 页
  开着时一直读，`internal/provider/checkin.go` 每分钟醒来、对「没说答案何时
  失效」的账号每 30 分钟重问一次签到。hook 拿不到「是谁问的」（`infoOf`
  只给 id/name/source/env/options/npm/api…），插件唯一能用的杠杆是一次读数
  回答多次询问。这个杠杆有下限：宿主自己已经按账号缓存一分钟
  （`cachedLoginReading`，`internal/provider/login_usage.go`），所以插件 TTL
  ≤60s 等于没省；而宿主缓存挡在插件前面，`refreshCards` /
  `forgetLoginReading` 穿不过去，用户按刷新可能被插件读数回答。取 180 秒是
  「确实省下」与「手按刷新不至于明显过期」之间最短的一档。
  `raccoon`：`auth.usage` 一次读数回答 `RACCOON_USAGE_TTL_MS`（默认 180000）
  内的所有调用，按账号单飞，失败读数另存 30 秒（登录失效从不缓存）；读数内部
  再按两端点各自的节奏分缓存——`RACCOON_ENTITLEMENT_TTL_MS`（默认 6 小时，
  套餐一年才变几次）、`RACCOON_BILLS_TTL_MS`（默认 10 分钟），余额每次都读。
  由于余额新鲜而流水不新鲜，窗口内到账的发放会表现为
  `grantedFromBills < avail`，这种答案按流水 TTL 重读一次（`billsHealedAt`），
  而不是报成负的 `used`。缓存按账号而不是 token 存，续期不会换来第二次读数；
  签到会清掉该账号的读数，按下之后看到的就是刚领到的数。
  `loomy`：`auth.usage` 同样（`LOOMY_USAGE_TTL_MS`，默认 180000）；
  `provider.models` 一次 `GET /api/v1/models` 回答
  `LOOMY_MODELS_TTL_MS`（默认 600000）——目录是应用的不是账号的，所以按 base
  存。失败的目录读取不缓存：静态表照样回答，下一次再问。
  两者的签到回答都带 `until`（下一个北京时间零点），`claimed` 与 `done` 都带，
  `failed` 不带。宿主把它解析成 `ValidUntil`
  （`internal/provider/plugin_checkin.go`），`settled()`
  （`internal/provider/workbuddy_checkin.go`）于是把答案扣到那一刻——这正是
  每 30 分钟重问的抑制条件，而该规则只在 `ValidUntil.IsZero()` 时生效
  （`checkin.go`）。用户按「签到」仍会重问
  （`if soon && prev.unclaimedAnswer() { settled = false }`），所以不吃亏。
  `raccoon` 的 `done` 是「流水里还没有新发放」而不是「厂商没发」（流水滞后于
  发放），所以它也说明何时再问；`loomy` 的签到仍要在 `first-login` 前后各读
  一次每日余额——这对读数是该端点唯一能给出的 claimed/done 判据。
  把对应的 `RACCOON_*_TTL_MS` / `LOOMY_*_TTL_MS` 设为 `0` 即关闭该缓存
  （测试就是这么用的）。
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
- **`loomy` 的请求头按客户端重建**：`packages/loomy/headers.mjs`。这不是
  装饰——插件与桌面客户端打的是同一个网关，请求长得不一样就分得出来。证据是
  客户端自己的流量：应用内置了 LLM 调试代理（`electron/llm/llm-debug-proxy.js`，
  `LOOMY_LLM_DEBUG_PROXY=1` 打开），把每次对话请求原样录下来，录稿在
  `.sandbox/loomy-captures/real-windows*/`，同时对照了从 `app.asar` 解出的源码。
  确认不了的取值宁可不写，也不编。
  抓包定下来的几件事：**认证是按面分的**——聊天面只有 `Authorization: Bearer`、
  **不发** `token`；目录、两个积分路径与 onboarding 只有 `token`、不发
  `Authorization`；画图面两个都发（插件原先处处都发）；`Content-Type` 是裸的
  `application/json`，**不带** charset（客户端 body 里全是中文、厂商照样回 200，
  原来那句「不带 charset 上游按 GBK 解码」的注释是错的）；`Accept` 分路径
  （聊天 `*/*`，那是 opencode 经 `@ai-sdk/openai-compatible` 发的；目录与画图
  `application/json`）；归属头确实存在——`chatid`（按会话固定的 UUIDv4）、
  `msgid`/`turnid`（同一个值，按请求）、`invokeorigin`、`x-loomy-request-purpose`、
  `x-session-affinity`。magpie 把会话以 `X-Magpie-Session` 交给插件，所以
  `chatid` 由它派生：同一会话固定，且形态像客户端的，而不是 magpie 的
  `magpie-<sha256>`；`x-session-affinity` 只在入参本身够格时才原样发——插件管不了
  谁调它，magpie 把 agent 报的会话原样转来（`internal/gateway/gateway.go` 的
  `sessionOf`，认九个头名），所以入参可能是 opencode 的 `ses_…`、Claude Code 的
  `cc-…`、一个裸 uuid，或者干脆没有。8 份真机请求全都是 `ses_` + 12 位十六进制 +
  14 位 base62，正好 30 字符，这是 opencode 自己的排布（magpie 在
  `internal/provider/opencode_client.go` 里按同一套造，并用「低 12 位是个很小的
  计数器」来判真）。所以这个形状原样发，别的形状一律派生成这个形状再发：原样透传
  等于自报调用方是谁（`cc-…` 是任何 Loomy 客户端都不会发的东西），而且非 ASCII 的
  值会让 `new Headers()` 直接抛错，请求在本地就死成 502，根本没发出去（实测）。
  这条不需要反向映射：厂商一个会话 id 都不回（响应头只有 `server`/`date`/
  `content-type`/`transfer-encoding`/`connection`/`cache-control`，SSE 里的 id 是
  它自己的 `cht…@dx…`），客户端 bundle 里也根本没有 `x-session-affinity` 这个串——
  它只发不读；UA 有两个——网关面走 opencode
  （`opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13`），
  账号域走 axios（`axios/1.21.0`），而 magpie 用不带 UA 参数的 bun 跑插件，
  不写就会自报 `Bun/1.4.2`。有两处故意与客户端不同、并写在设置处：purpose 恒为
  `chat.message`（插件分不出聊天/起标题/抽记忆，客户端有 17 个值：`chat.message`、
  `chat.title`、`pet.comment`、`pet.reward`、`kb.vision`、`kb.audio`、`kb.summary`、
  `kb.embed`、`search.web`、`image.generate`、`assistant.completion`、
  `assistant.asr-correct`、`memory.extract`、`memory.recall`、`memory.dream`、
  `skill.evolution`、`skill.curator`——这 17 个记在这里而不是写成代码里的集合，
  因为插件没有任何一处能择优），UA 是写死的
  字面量而非探测出来的（magpie 不告诉插件它跑在哪个 opencode 版本下）；
  `LOOMY_CLIENT_UA` / `LOOMY_ACCOUNT_UA` 可覆盖。同一批抓包还否掉了一处 body
  改写：插件原先把 DeepSeek 的图片段改写成 `<image_base64>…</image_base64>`
  文本标记，而客户端发的就是普通 `image_url`、模型能看图（实测 4 段、厂商 200、
  模型完整描述了截图）。现在把 8 份真机 body 原样回放，逐字节相同，由
  `tools/replay-real.mjs` 验证、`tools/gen-table.mjs` 报告。
  有一件后果要说清：`packages/loomy/README.md` 保持上游原样，所以它「聊天」那条
  仍然写着旧形态——「请求头必须带 `charset=utf-8`（上游对无 charset 的 body 按
  GBK 解码）」和「DeepSeek 系模型的图片转 `<image_base64>` 标记」。这两句现在都不
  成立。本文件第 4 行的规矩就是让它保持原样，更正写在这里而不是那里。
  这里还要说清一件它**没有**证明的事：`packages/loomy/fake.mjs` 现在强制上述
  按面分发，所以插件若退回「处处都发两个头」测试会红。但测试全绿的含义是
  **插件与抓包一致**，不是**网关要求如此**——客户端证明了新形态被接受，
  没有任何东西证明旧形态会被拒。后者只能靠真机实跑。

  另有三份公开移植（`xxhhlk`、`Patrick130306`、`xingluoyuankong`，后两者共用
  同一份 `build_model_headers`）可作交叉参照。它们能做的是复核**字段名**，
  不能复核**客户端行为**：它们都是网关，目标是让上游**接受**请求，所以发的头是
  被接受的集合的并集，而不是客户端真正发的子集。与抓包冲突的地方以抓包为准：

  | 它们发 | 0.9.39 客户端发 |
  |---|---|
  | `Authorization` **和** `token`（「session 模式双写」） | 只有 `Authorization`（8 份抓包里 `token` 出现 0 次） |
  | `Accept: application/json` | `*/*` |
  | 完全不发自己的 `User-Agent`（stdlib `http.client`，或 httpx 的 `python-httpx/…`） | `opencode/1.14.22 ai-sdk/provider-utils/…` |
  | 除非调用方自己塞，否则不发 `ChatId`/`MsgId`/`TurnId`/`InvokeOrigin`/`X-Session-Affinity` | 五个全发 |

  第四份是 `Buddy2api`（七个渠道的网关，不是 `loomy2api` 的分支），值得单说：
  它是四份里唯一自己写 `X-Loomy-Request-Purpose` 而不是转发的，但面的划分和
  另外三家错得一样——一个 `model_headers()` 同时服务 chat、`/models` 和
  `/points/records`，`Accept` 一律 `application/json`，读积分那一路也照样挂
  `purpose="chat.message"`。它还自己发明了每账号设备号（`devid = "web-<16 hex>"`，
  客户端的 `_makeBase()` 发的是常量 `"web"`），完全不做短信登录（只有密码），
  也没有 `/points/first-login`——它的「领取」只是把 `dailyBalance` 读回来说
  `already_claimed`。它独立印证了两件事：本插件从 `.env.prod` 里解出的同一对
  AK/SK，以及同样的九行待签串、同样的顺序。它自己的测试也是模拟上游
  （「上游与登录均使用模拟响应，未调用真实账号」），所以同样不是实跑证据。

  它们那 17 个 purpose、`traceparent` 与 `loomy-version` 的形态与我们一致，属于互相印证。
  有两条它们的说法是错的，已按抓包否掉而不是照抄：`/models` 声明
  `reasoning_efforts`（该字段在 231 MB 的 `app.asar` 里 0 命中，同一搜索下
  `useSessionAuth` 有 31 命中，客户端的选择器是固定的 low/medium/high、默认
  medium）；以及「`reasoning_effort` 无效、只有 `/no_think` 前缀有效」（客户端
  发的就是 `reasoning_effort`，`/no_think` 在客户端里 0 命中）。
  但它们指出的一个字段名确实是我的错：目录里输出上限叫 `max_output_tokens`，
  客户端的映射按 `limit.output → max_output_tokens → max_completion_tokens` 读，
  而插件读的是目录里从不出现的 `max_tokens`，因此线上发现的模型**输出上限一直
  是空的**，只有 `STATIC_MODELS` 里写死的数字会显示。已修，并让 fake 改用目录
  真实的字段拼写。
