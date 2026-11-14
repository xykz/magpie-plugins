# What this fork adds

This is a fork of
[magpie-community/plugins](https://github.com/magpie-community/plugins). The
packages themselves, how to write one, and how publishing works are described
in upstream's [README.md](README.md) and in each package's own `README.md` —
this fork leaves all of them exactly as upstream wrote them, so that a merge
from upstream never has to merge past a fork edit. What this fork adds on top
of them is written down here, in a file of its own.

Package versions are upstream's three numbers, plus one of this fork's: a fork
release is `<upstream version>-fork.<n>`, so `0.2.16-fork.1` is the first fork
release of the version upstream published as `0.2.16`, and `0.2.16-fork.2` is
that same release with one more fork change on it. `n` counts fork releases
only; it starts at 1 and goes up by one each time. When upstream publishes a
new version, the base — upstream's three numbers — moves, and `n` starts again
at 1 (`0.2.17-fork.1`), which semver already orders after every
`0.2.16-fork.*`.

The suffix earns its keep: semver has no fourth number, and the three-number
form a fork reused would read to magpie as an older version than the upstream
release it is based on. `-fork.<n>` is a pre-release, so `0.2.16-fork.1` sorts
*before* `0.2.16` — right, because upstream's release is the one without this
fork's changes — and before `0.2.17`, so upstream moving on is still seen as an
update. For the same reason this fork does not use build metadata
(`0.2.16+1`): semver compares `0.2.16+1` and `0.2.16+2` as equal, so the second
fork release would look like the first.

A consequence to know: a version with a suffix is a *pinned* spec to magpie
(`Pinned`), so a fork release never auto-updates — the Plugins page notes a
newer version and the reader installs it. That suits a fork, whose numbers
upstream has never published.

The base is the version upstream had when the fork change went in, not
whatever `packages/*/package.json` said last: this fork merges upstream's
releases and re-reads them, and a merge that brings upstream's own version
bump in must be followed by moving the base up (and `n` back to 1).

## One switch per plugin, and what each of them turns on

All three of this fork's plugins put their difference from upstream behind a
single magpie switch (`auth.options`), off by default: off sends what upstream
sends, on sends what the vendor's own client sends. They are drawn in the
provider's editor under the models — Provider › Edit › **Plugin options** — and
magpie reads them as the plugin works, so a flip reaches the next request and
nothing restarts.

| Plugin | Switch | On means |
|---|---|---|
| `workbuddy` | `request_format_2108` — *Send as CodeBuddy CLI 2.108.1* | chats go out in the CLI's shape |
| `raccoon` | `request_shape_desktop_1_1_5` — *Send as the Raccoon desktop app 1.1.5* | chats go out in the app's shape |
| `loomy` | `request_shape_client_0_9_39` — *Send as the Loomy client 0.9.39* | chats go out in the client's shape |

The switches cover the *request's shape* and nothing else: headers, the body's
transform, the stream's framing. What each plugin reads off the vendor — the
credit windows, the model lists, the check-in, the sign-in's renewal — is not
behind a switch, because turning that off would make the plugin lie about the
account instead of sending a different client. The sections below say for each
plugin exactly where the line is.

**In OpenCode** there are no switches, so each plugin reads its shape from
what OpenCode does have: `raccoon` and `loomy` keep the vendor client's shape
there — the same thing their switch asks for, so a missing `input.magpie` is
read as "on" rather than "off" (`shapeOf` in each `extras.mjs`), while
`workbuddy` goes by its install tuple's `requestFormat` value and sends
magpie's own shape when that says nothing (`formatOf` in its `index.mjs`).

A switch declares no `default: true`, so a fresh install sends upstream's
request until someone turns it on. magpie caps an option's label at 60
characters and its description at 300 (`host.js`'s `shown`), silently
truncating anything longer; the two plugins that declare a switch assert in
their tests that all four languages fit.

## `workbuddy`: the CodeBuddy CLI 2.108.1 request shape

A chat to the China build can go out in the shape of the official CodeBuddy
CLI, `@tencent-ai/codebuddy-code` 2.108.1, instead of WorkBuddy's own desktop
app.

**In magpie** it is a switch (`auth.options`), drawn with the plugin's other
switches in the provider's editor — WorkBuddy › Edit › **Plugin options**, under
the models:

| Switch | On means |
|---|---|
| `request_format_2108` — *Send as CodeBuddy CLI 2.108.1* | chats go out in the CLI's shape |
| off | chats go out in WorkBuddy's desktop app's shape |

A switch takes effect on the next request (magpie keeps it, then reads it as it
works); nothing restarts. The AI build declares no such switch: it has the one
format.

**In OpenCode** there are no switches, so the format comes from the plugin
tuple's second entry:

```json
["@magpie-community/opencode-workbuddy-auth", { "requestFormat": "codebuddy-2108" }]
```

A switch wins over the tuple (a host with switches is one whose user set them
and can't see the tuple), and with no switch on the tuple's value stands.
`"magpie"`, the default, is the format every request used before the option
existed, and a value naming neither is read as `"magpie"`, so a typo sends what
every request sent before rather than failing a chat.

A third format is one more boolean switch beside this one, and the newest one on
sends: magpie hands a plugin nothing when a switch changes, so no switch can
tell whether another was turned on after it, and the plugin fixes the order
instead of letting the last one clicked win.

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

## `raccoon`: the desktop app's request shape, on a switch

Everything this fork does to a chat on its way out — the desktop app's
headers, thinking in its own per-family shape, the `max_tokens` floor,
`stream_options` — rides on one magpie switch, off by default.

**In magpie** it is a switch (`auth.options`), drawn with the plugin's other
switches in the provider's editor — Raccoon › Edit › **Plugin options**, under
the models:

| Switch | On means |
|---|---|
| `request_shape_desktop_1_1_5` — *Send as the Raccoon desktop app 1.1.5* | chats go out in the app's shape |
| off | chats go out in upstream's shape |

A switch takes effect on the next request (magpie keeps it, then reads it as
it works); nothing restarts.

**In OpenCode** there are no switches, so the request keeps the app's shape —
the same thing the switch asks for. That is why "no `input.magpie`" is not
"off": `shapeOf` in `packages/raccoon/extras.mjs` reads it that way.

What the switch does **not** carry: the vision whitelist and the picker
fallbacks, the `refresh_conflict` heal, the phone-side grant and the check-in
triage. Those are readings of what the vendor says rather than shapes of the
request, and turning them off would make the plugin lie about the account
rather than send a different client.

`RACCOON_USER_AGENT` still overrides the SDK's own UA the switch puts on; set
it to an empty string to leave magpie's own alone.

The one thing it does not change is the version it reports of itself:
`packages/raccoon/package.json` is `0.1.5-fork.2`, upstream's number with this
fork's suffix (above) — the package is not renamed, so what a vendor sees is
still upstream's own name.

## `raccoon`: what the app's request shape is

The User-Agent was the first half of a larger difference. All of what follows
is what the switch above turns on. The desktop app's
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

## `raccoon`: a renewal answers for its own account, and a check-in reads back

Two readings of the vendor's answers, neither of them a shape of the request,
so neither is behind the switch above.

**A renewal is taken only if it answers for the seat's own account.** The
desktop app signs in to one account at a time and rotates its own refresh
token, so a token that moved can answer for someone else; taking it billed the
seat to that account and showed its credits (upstream #166). `callRefreshApi`
now carries the uid the seat was signed in with (`expectedUid`) and refuses a
different one — the stored credential is left exactly as it is, the seat is not
marked expired (`signIn: "kept"`), and a later attempt can still answer its own
account.

**A check-in reads the credits list again after claiming.** The list is
written behind the grant and lags a minute or three, so a read taken
immediately after the claim called a paid day unpaid. The claim now re-reads,
falls back to the vendor's own grant flags in `setting_info` when the list is
still behind, and counts a day once — a flag still present on the next call is
not counted twice. Concurrent check-ins for one account share a single run
(`checkinInFlight`).

## `raccoon`: the day's points run out before the permanent ones

The vendor keeps two kinds of points apart. `/api/web/points/v1/balance`
answers `daily_points` and `reward_points` beside the total: the first is the
day's grant (300 a check-in), worth nothing after Beijing midnight, and the
second — with the monthly and top-up buckets — never lapses. The bills say the
same thing from the other side: a `daily_grant` carries an `expire_at` of that
day's 23:59:59+08:00, a `reward_grant` carries none.

The plugin reported one `Credits` window over the total, so magpie saw a single
number and could not put an account with a day left behind one without: the
permanent points an account already holds would keep it in front while the
grant nobody spent expired at midnight. It now reports the two apart, each at
its own time.

- **`每日积分`** carries the day. With an unexpired `daily_grant` to say what
  the day was worth, it is a share (`used`, 0–100) plus its count, renewing at
  Beijing midnight (`resetsAt`) and `span: 86400`. Without one — unreadable
  bills, or the day before its first check-in — it is the balance alone: a
  made-up limit would always read as full. A spent day with nothing to say of
  it is `used: 100`, which is a known, used-up account where an empty window
  list would be an unknown one.
- **Both readings carry `balance`**, so the card says the same thing either
  way. magpie's `quotaText` reads a balance before it reads a share
  (`app.js`: `if (w.balance != null) return t("{n} left", ...)`), so an account
  whose bills came back and one whose did not both say "剩余 519 积分" instead of
  one showing `519 / 600 · 剩余 100%` and the other a bare total. A balance of
  0 is left out: `Allowance.Left` takes the least balance in the unit, and a
  window saying 0 while its day is merely spent would drag the account's
  `Left` to nothing beside the wallet.
- **Both name when the day ends**, `resetsAt` and `span` and `runsOutAt` —
  and that is a routing fix, not decoration. A window that names neither a
  reset nor a span leaves `Seat.Soon` at its zero value, and Smart files a seat
  whose renewal is unknown *behind every seat that told one* (`strategies.go`:
  `case x.IsZero() || y.IsZero(): return y.IsZero()`, "not known: after those
  known") — for good, so the account is never picked while any other in the
  pool has credit left. `resetsAt`/`span` alone are not enough either: the day
  lapses at 23:59:59+08 (where a `daily_grant`'s `expire_at` points), one
  second before the midnight it resets at, and `Allowance.Renewal` folds a
  lapse that comes before the reset into it — so `runsOutAt` is what ties with
  an account whose bills *were* read. A window quoting no bill names
  `nextBeijingMidnight() - 1000` itself.
- **`每日积分` never steps aside**, because its share is the only reading
  magpie can order an account by — an aside window never reaches
  `allowanceOf`, and a day set aside would leave the account with no share at
  all, which `usage` ranks *ahead* of a day nearly gone. The mark that ends the
  day's priority is its last point, not magpie's own 98%: two points still pay,
  so the account holding them still goes ahead of one whose day is gone.
- **`永久积分`** is the wallet, the rest of `available_points` after the day's
  bucket rather than the named buckets summed — a bucket the vendor adds later
  is permanent by default instead of vanishing. It is `aside: true` while
  anything of the day is left, and joins without the day's window stepping
  aside once the day is gone.

What that makes the pool do is the point. A window set aside never reaches
`allowanceOf` (`routing.go`: `if w.Aside || w.Text { continue }`), so while any
day in the pool is left, only the days are weighed and the wallets cannot drag
an account forward; the pool spends the days first. Once a day is gone its
share stays at 100, which files the account in the used-up tier
(`tier`, `routes/strategies.go`) — behind every account whose day still has
something in it, whatever its wallet holds — and `Allowance.For` takes the max
share while `Allowance.Left` takes the min balance, each window on its own, so
under `usage` the balance breaks the tie inside that tier. Stepping the day
aside instead would read as an account with no share at all, which `usage`
ranks *ahead* of a day nearly gone — the wrong end. An empty wallet is no
window at all: magpie reads a lone `balance: 0` as used up, which would bench
an account its day still pays for.

The vendor's own buckets are read as the split's source, so `daily_points`
absent is the old reading: one `Credits` share over every unexpired grant,
else the balance as a wallet. That keeps a vendor reply without the buckets —
or a relay that strips them — from having its split guessed at.

Tested with `bun test packages/raccoon` (131 tests, 446 assertions, across four
files: the day's share and the permanent wallet from the vendor's own buckets,
the wallet aside while the day pays and weighing once it does not, an empty
wallet making no window, and the old single-window reading for a reply without
`daily_points`) and `bun scripts/check.mjs` (every package ✓).

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

**In magpie** all of it is one switch (`auth.options`), off by default, drawn
in the provider's editor — Loomy › Edit › **Plugin options**, under the models:

| Switch | On means |
|---|---|
| `request_shape_client_0_9_39` — *Send as the Loomy client 0.9.39* | chats go out in the client's shape |
| off | chats go out in upstream's shape |

A switch takes effect on the next request; nothing restarts. **In OpenCode**
there are no switches, so the request keeps the client's shape — the same
thing the switch asks for, which is why "no `input.magpie`" is not "off"
(`shapeOf` in `packages/loomy/extras.mjs`).

What the switch does not carry: the password sign-in and its renewal
(`renew.mjs`), and the onboarding ledger. Those are the account's life rather
than the request's shape.

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

### The two point wallets: which one carries the account

Loomy reports two balances and they are not alike: a **daily grant** of 5000
points per account, refreshed by the vendor on the day's first login and worth
nothing after Beijing midnight, and **permanent points**, which differ per
account and never expire. The vendor spends the grant first and the wallet only
once the day is gone — so the grant decides who answers, and the wallet decides
only among accounts whose grant is already gone.

magpie weighs an account only by the windows a plugin does *not* set aside
(`allowanceOf`: `if w.Aside || w.Text { continue }`), and an account with no
window left carries no allowance at all — the Routing page reads 剩余额度未知.
So the grant always carries, and the wallet joins it once the day is spent:

- **The grant carries at every share, 0% to 100%.** It is the one with a share
  (`used`, 0–100) and an expiry, and that share is the only reading magpie can
  order an account by: `usage` compares it directly, `pace` divides what is left
  by the hours until it renews, and `smart` — the default — sorts on it for
  nothing more than its tier (fine below 90%, low, spent past 98%), which is
  enough to keep a nearly-spent day behind a fresh one.
- **The mark is the day's last point, not magpie's 98%.** Those last two points
  of grant still pay, so they are still spent first; the wallet must not weigh
  while anything in the grant is left, or a wallet-heavy account would jump
  ahead of one still holding 10% of its day.
- **Once the day is gone the wallet weighs *beside* the grant, and the grant
  does not step aside.** `used: 100` keeps the account in the used-up tier, so
  it stays behind every account whose day still has something in it, however
  large its wallet; and `Allowance.For` takes the max share while
  `Allowance.Left` takes the min balance from separate windows, so the balance
  breaks the tie *inside* that tier. The grant stepping aside instead would read
  as an account with no share at all, which `usage` keeps ahead of a day nearly
  gone — the wrong side entirely.
- **The wallet ranks the spent accounts under `usage`**, which compares the
  share first and the balance after it (`LeastUsed`). `smart` and `pace` order
  the used-up tier by the share alone, so there the balance decides nothing —
  it is never weighed early, which is the part that matters.
- **An empty wallet never weighs**, because magpie reads a lone `balance: 0` as
  used up and would say a spent account has nothing at all. Nor does a wallet
  with no limit/remaining pair to rank against: there the day's own
  `dailyBalance` carries.
- **Both readings of the grant carry `balance`**, so the card says the same
  thing whether or not the limit pair came back: magpie's `quotaText` reads a
  balance before a share (`app.js`: `if (w.balance != null) return t("{n}
  left", ...)`), so an account whose pair arrived and one whose did not both
  read 剩余 3000 积分.
- **Both name when the day ends** — `resetsAt`, `span`, `runsOutAt` — and that
  is a routing fix. A window naming neither a reset nor a span leaves
  `Seat.Soon` at its zero value, and Smart files a seat whose renewal is unknown
  *behind every seat that told one* (`strategies.go`: "not known: after those
  known"), for good: never picked while any other account in the pool has
  credit. `resetsAt`/`span` alone do not settle it — the grant lapses at
  23:59:59+08, one second before the midnight it resets at, and
  `Allowance.Renewal` folds a lapse that comes before the reset into it — so
  `runsOutAt` is what ties with an account whose pair *was* read. A window that
  read no pair names `nextBeijingMidnight() - 1000` itself.
- **A spent grant with no wallet at all keeps carrying**, because a lone
  `used: 100` is a *known*, used-up account where an empty window list is an
  unknown one and the Routing page would say nothing.

Nothing is added up anywhere, either: `Allowance.For` takes the max share across
windows and `Allowance.Left` the min balance, and the one place balances are
summed is the Usage page's cross-account summary (`mergeQuotas`), which routing
never reads.

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

版本号是上游那三段加上 fork 自己的一位：一次 fork 发版写成
`<上游版本>-fork.<n>`，`0.2.16-fork.1` 就是上游发的 `0.2.16` 之上的第一次
fork 发版，`0.2.16-fork.2` 是同一版上又多了一处 fork 改动。`n` 只数 fork
自己的发版，从 1 开始，每改一次加一。上游发了新版本，base 跟着走、`n` 重回
1（`0.2.17-fork.1`）—— semver 本来就把它排在所有 `0.2.16-fork.*` 之后。

这个后缀是有用的：semver 没有第四段，而 fork 若沿用三段式自己加号，magpie
会把那个号读成比它基于的上游版本更旧的版本。`-fork.<n>` 是预发布，因此
`0.2.16-fork.1` 排在 `0.2.16` **之前** —— 这是对的，不带 fork 改动的才是上游
那一版 —— 又排在 `0.2.17` 之前，所以上游一旦前进仍然算更新。同理本 fork
不用 build metadata（`0.2.16+1`）：semver 认为 `0.2.16+1` 与 `0.2.16+2`
相等，第二次 fork 发版会看起来和第一次是同一个。

有个后果要知道：带后缀的版本对 magpie 是**固定**（`Pinned`）的 spec，所以
fork 发版从不自动更新 —— Plugins 页会提示有更新，由人来装。这对 fork 正合适，
因为这些版本号上游从来没发过。

base 是 fork 改动落地时上游的那个版本，不是 `packages/*/package.json` 上次写的
那个：本 fork 会合并上游发布再重读它们，若某次合并带进了上游自己的版本号提升，
就必须顺手把 base 抬上去（并把 `n` 归 1）。

### 三个插件各一个开关，开关管的是请求形状

本 fork 的三个插件都把与上游的差别收在一个 magpie 开关（`auth.options`）
后面，默认关闭：关＝上游本来发的请求，开＝厂商自己客户端发的请求。开关画在
提供商编辑器的模型列表下面 —— 提供商 › 编辑 › **插件选项** —— magpie 边用边
读，打开后下一笔请求即生效，不重启任何东西。

| 插件 | 开关 | 打开的含义 |
|---|---|---|
| `workbuddy` | `request_format_2108` — *Send as CodeBuddy CLI 2.108.1* | 按 CLI 的形状发 |
| `raccoon` | `request_shape_desktop_1_1_5` — *Send as the Raccoon desktop app 1.1.5* | 按桌面端的形状发 |
| `loomy` | `request_shape_client_0_9_39` — *Send as the Loomy client 0.9.39* | 按客户端的形状发 |

开关只管**请求的形状**：请求头、请求体的改写、流的包装。插件从厂商读回来的
东西 —— 积分窗口、模型列表、签到、登录态的续期 —— 不在开关后面，因为把它们
关掉是让插件对账号说谎，而不是换一个客户端发请求。每一节下面写了那条线画在
哪里。

**在 OpenCode 里没有开关**，因此插件改读 OpenCode 有的东西：`raccoon` 与
`loomy` 在那里保持厂商客户端的形状 —— 正是它们开关打开时要求的东西，所以
`input.magpie` 缺席被读作"开"而不是"关"（各自的 `extras.mjs` 里叫 `shapeOf`）；
`workbuddy` 则按安装 tuple 里的 `requestFormat` 取值，那里没写时发 magpie 自己的
形状（`index.mjs` 的 `formatOf`）。

开关不带 `default: true`，所以新装的插件发的是上游的请求，直到有人把它打开。
magpie 把选项的 label 截到 60 字符、description 截到 300（`host.js` 的
`shown`），超长的部分静默丢掉；带开关的两个插件在测试里断言四种语言都在限内。

- **`workbuddy` 的 CodeBuddy CLI 2.108.1 请求形状**：可以按官方 CodeBuddy
  CLI（`@tencent-ai/codebuddy-code` 2.108.1）的形状，而不是桌面客户端的形状，
  向中国版发对话请求。在 magpie 里它是 provider 编辑器里的一个开关（`auth.options`，
  WorkBuddy › Edit › **Plugin options**，在模型列表下面）：`request_format_2108`
  打开即按 CLI 形状发送，关闭即按桌面端形状发送；下一笔请求就生效，不重启。
  中国版的 AI 版不声明这个开关（AI 版只有一种形状）。在 OpenCode 里没有开关，
  形状来自插件 tuple 的第二项：
  `["@magpie-community/opencode-workbuddy-auth", { "requestFormat": "codebuddy-2108" }]`。
  开关压过 tuple（有开关的宿主就是用户设过开关、看不见 tuple 的那种）；没有
  开关打开时 tuple 的值照旧生效；默认值 `"magpie"`（即该选项出现之前每个请求
  的形状），写了不认识的值也按 `"magpie"` 处理。第三种形状 = 旁边再加一个布尔
  开关，按列表顺序最新优先——magpie 在开关变化时不回调插件，所以做不出"最后点的
  那个赢"。九个请求头、不压缩、强制流式并把分片拼回一个完整回复、
  `reasoning_effort` 的处理、`max_tokens`/`max_completion_tokens` 按模型区分，
  细节见上一节；形状本身在 `packages/workbuddy/codebuddy.mjs`，
  `packages/workbuddy/format.test.mjs` 把它钉在真实的抓包上。
- **`raccoon` 的桌面端请求形状，一个开关**：本 fork 对发出的对话所做的一切 ——
  桌面端的请求头、按模型分派的 thinking、`max_tokens` 下限、`stream_options` ——
  都挂在一个 magpie 开关上，默认关闭。在 magpie 里它是 provider 编辑器里的
  `auth.options`（Raccoon › Edit › **Plugin options**，在模型列表下面）：
  `request_shape_desktop_1_1_5` 打开即按桌面端 1.1.5 的形状发送，关闭即按上游
  的形状发送；下一笔请求就生效，不重启。在 OpenCode 里没有开关，请求保持桌面端
  形状 —— 也就是这个开关所要的东西，所以 `packages/raccoon/extras.mjs` 的
  `shapeOf` 把"没有 `input.magpie`"读作开启而不是关闭。开关不管：vision 白名单与
  选择器的回落项、`refresh_conflict` 的愈合、手机端赠分与签到分诊 —— 那些是读
  厂商说了什么，不是请求的形状，关掉它们只会让插件对账号说谎。
  `RACCOON_USER_AGENT` 仍可覆盖开关装上的 UA，空串则保留 magpie 自己的。
- **`raccoon` 的续期只认本席位自己的账号，签到会回读**：两件事都是对厂商回答的
  读法，与上面那个开关无关。桌面端一次只登一个账号并轮换自己的 refresh token，
  所以一个被搬走的 token 可能替别的账号回答；照收就把席位记到了那个账号名下、
  显示的是它的积分（上游 #166）。`callRefreshApi` 现在带上席位登录时的 uid
  （`expectedUid`），不是同一个就拒收 —— 本地凭据原样保留、席位不标记过期
  （`signIn: "kept"`），之后的重试仍能回答自己的账号。签到则在领取后**再读一遍**
  积分流水：流水写在发放之后、滞后一两分钟，所以领完立刻读会把已经发放的一天
  判成未发放；现在领完回读，流水仍滞后时用 `setting_info` 里厂商自己的发放标记
  兜底，且每天只计一次 —— 下一次调用仍带着该标记时不会重复计。同一账号的并发
  签到共用一次执行（`checkinInFlight`）。
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
- **`raccoon` 的日积分先于永久积分用完**：厂商把两种积分分开——
  `/api/web/points/v1/balance` 在总额之外还回 `daily_points` 与
  `reward_points`：前者是当天赠送（签到 300），过了北京时间午夜作废；后者连同
  包月、充值一起永不过期。流水从另一侧说同一件事：`daily_grant` 带
  `expire_at`（当天 23:59:59+08:00），`reward_grant` 不带。插件原先只报一个
  `Credits` 窗口（总额），magpie 因此只有一个数字，无法把「今天还有额度」的
  账号排到「没有」的后面：已经有大量永久积分的账号会一直靠前，而没人花掉的
  日赠送在午夜白白过期。现在拆成两个窗口，各按自己的时间说话：
  - **`每日积分`** 代表当天。有未过期的 `daily_grant` 说明当天额度多少时，
    它是一个 share（`used`，0–100）加计数，按北京午夜重置（`resetsAt`）、
    `span: 86400`；没有时（流水读不到，或当天还没签到）只带余额——编一个上限
    永远读成满格。当天用完又无据可依时是 `used: 100`：这是「已知用完」的账号，
    而空窗口列表会被当成未知。
  - **两种读法都带 `balance`**，所以无论流水读没读到，卡片说的话都一样。
    magpie 的 `quotaText` 先看余额再看 share（`app.js`：
    `if (w.balance != null) return t("{n} left", ...)`），于是流水读得到和读不
    到的账号都显示「剩余 519 积分」，而不是一个 `519 / 600 · 剩余 100%`、另一
    个只有总额。余额为 0 时不带：`Allowance.Left` 取同一单位里最小的余额，当天
    只是用完、窗口却报 0，会把该账号的 `Left` 拉到 0，反而被钱包压下去。
  - **两种读法都说明当天何时结束**：`resetsAt`、`span`、`runsOutAt`。这不是装
    饰而是路由修复——窗口既不报重置也不报 span，`Seat.Soon` 就停在零值，而
    Smart 把「续期未知」的座位排在**所有报出续期的座位之后**
    （`strategies.go`：`case x.IsZero() || y.IsZero(): return y.IsZero()`），
    且是永久排后，于是只要池子里别的账号还有额度，它就永远不会被选中。只有
    `resetsAt`/`span` 也不够：当天额度在 23:59:59+08 就作废（`daily_grant` 的
    `expire_at` 指向那里），比它重置的午夜早一秒，而 `Allowance.Renewal` 会把
    早于重置的作废折进重置里——所以能和「流水读到了」的账号打平的是
    `runsOutAt`。没读到流水的窗口自己写 `nextBeijingMidnight() - 1000`。
  - **`每日积分` 永不 aside**，因为它的 share 是 magpie 唯一能用来排序的读数。
    0% 就是 0%，而那最后两点也还能花，所以分界是当天的最后一点，不是 magpie
    自己的 98%。
  - **`永久积分`** 是钱包，取 `available_points` 减掉当天那桶，而不是把具名的
    几桶加起来——厂商以后新增的桶默认永久，不会凭空消失。当天还有额度时它是
    `aside: true`，当天用完后才不 aside 地并列进来。

  这正是让选号行为正确的关键。被 aside 的窗口根本进不了 `allowanceOf`
  （`routing.go`：`if w.Aside || w.Text { continue }`），所以只要池子里还有任何
  一天的额度，参与排序的就只有日积分，钱包无法把某个账号往前拽；整个池子先把
  日积分花光。某天的额度用完后 share 停在 100，把该账号归进已用尽档
  （`tier`，`routes/strategies.go`）——排在所有当天还有额度的账号之后，无论它
  钱包里有多少——而 `Allowance.For` 取最大 share、`Allowance.Left` 取最小余额，
  两个窗口各算各的，所以 `usage` 排序下余额在这一档内决胜负。若反过来让日积分
  aside，该账号会读成一个「完全没有 share」的账号，而 `usage` 把这种排在「快
  用完」的账号**前面**——正好反了。空钱包不作为窗口：magpie 把单独的
  `balance: 0` 读成用尽，会把当天还在付钱的账号 bench 掉。

  拆分的数据源是厂商自己的分桶，所以 `daily_points` 缺席时即为旧读法：一个
  `Credits` 窗口跨所有未过期发放，或者余额当钱包。这样厂商回复里没带分桶（或
  中继把它剥掉）时，不会去猜一个拆分出来。

  测试：`bun test packages/raccoon`（131 条、446 个断言，四个文件：按厂商分桶
  拆出日 share 与永久钱包、当天还有额度时钱包 aside 而用完时参与、空钱包不
  生成窗口、没有 `daily_points` 时走旧的单窗口读法）与
  `bun scripts/check.mjs`（每个包 ✓）。
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
  确认不了的取值宁可不写，也不编。在 magpie 里这一切是一个开关（`auth.options`，
  默认关闭，Loomy › Edit › **Plugin options**，在模型列表下面）：
  `request_shape_client_0_9_39` 打开即按客户端 0.9.39 的形状发送，关闭即按上游
  的形状发送；下一笔请求就生效，不重启。在 OpenCode 里没有开关，请求保持客户端
  形状（`packages/loomy/extras.mjs` 的 `shapeOf` 把"没有 `input.magpie`"读作开启）。
  开关不管密码登录与它的续期（`renew.mjs`），也不管新手任务账本——那些是账号的
  生命，不是请求的形状。
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
- **`loomy` 两个积分窗口由谁承载账号**：Loomy 报两个余额，性质完全不同——
  每日赠送 5000 分，厂商在当天首次登录时刷新，过了北京零点就作废；永久积分则
  每个号不一样、永不过期。厂商先扣每日、用完才动永久，所以**由每日积分决定谁
  应答，永久积分只在整个池子的当日都花完之后才参与决定**。magpie 只按没被
  `aside` 的窗口称量账号（`allowanceOf`：`if w.Aside || w.Text { continue }`），
  一个窗口都不剩的账号等于没有额度信息（Routing 页显示「剩余额度未知」），所以
  **每日赠送始终承载，永久积分在当日花完后加入一起承载**：
  - **0% 到 100% 都由每日赠送承载**。它有份额（`used` 0–100）也有过期时间，而
    这个份额是 magpie 唯一能拿来做账号排序的读数：`usage` 直接比它，`pace` 用它
    除以距续期的小时数，`smart`（默认）则只拿它分桶（90% 以下 fine、98% 以上
    spent），也足以让快用完的当日排在新鲜的当日之后。
  - **分界点是当日的最后一点，不是 magpie 的 98%**。那两点额度照样能用，所以还得
    先花掉；只要每日还剩任何额度，永久积分就不参与称量，否则钱包余额大的号会插到
    一个当日还剩 10% 的号前面。
  - **当日花完之后永久积分与每日一同承载，而不是顶替每日**。`used: 100` 保留账号
    在「已用完」这一档，因此它排在所有当日还有额度的账号之后——不管永久余额多大；
    而 `Allowance.For` 取最大份额、`Allowance.Left` 取最小余额，来自各自的窗口，
    于是永久余额只在**这一档内部**打破平手。若反而让每日 `aside` 掉，账号就成了
    「没有份额」，而 `usage` 把这种排在「份额快用完」的**前面**——方向正好反了。
  - **钱包在这一档里的排序由 `usage` 体现**：`LeastUsed` 先比份额、再比余额。
    `smart`/`pace` 在「已用完」档只比份额，所以那里永久余额不决定任何东西——但它
    永远不会被提前称量，这才是关键。
  - **空钱包不参与称量**：magpie 把孤零零的 `balance: 0` 读成已用尽，写进「已用完」
    档等于宣布这个号什么都没了。没有 limit/remaining 这对数字时也一样不参与——那
    时由每日自己的 `dailyBalance` 承载。
  - **每日用完而根本没有永久窗口时，仍然让每日承载**：孤零零的 `used: 100` 是
    「已知、已用完」的账号，而一个窗口都没有是「未知」，Routing 页会什么都不说。
  - **两种读法都带 `balance`**，所以 limit/remaining 这对数字回没回来，卡片说的话
    都一样：magpie 的 `quotaText` 先看余额再看份额（`app.js`：
    `if (w.balance != null) return t("{n} left", ...)`），于是拿到了对的号和没拿到
    的都显示「剩余 3000 积分」。
  - **两种读法都说明当天何时结束**：`resetsAt`、`span`、`runsOutAt`。这是路由
    修复：窗口既不报重置也不报 span，`Seat.Soon` 就停在零值，而 Smart 把「续期
    未知」的座位永久排在所有报出续期的座位之后（`strategies.go`：「not known:
    after those known」），于是池子里还有别的账号有额度时它永远不会被选中。只有
    `resetsAt`/`span` 也不够——当天额度在 23:59:59+08 就作废，比午夜早一秒，而
    `Allowance.Renewal` 会把早于重置的作废折进重置，所以能和「读到了这对数字」
    的账号打平的是 `runsOutAt`。没读到这对数字的窗口自己写
    `nextBeijingMidnight() - 1000`。
  另外，任何地方都不做加法：`Allowance.For` 在各窗口间取最大份额、`Allowance.Left`
  取最小余额，唯一相加的地方是 Usage 页的跨账号汇总（`mergeQuotas`），路由从不读它。
