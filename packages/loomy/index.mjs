// @magpie-community/opencode-loomy-auth — the Loomy (讯飞) provider plugin
// for OpenCode and magpie.
//
// Signs in with a Loomy account (password, SMS code, or a pasted session),
// forwards chat completions to its OpenAI-compatible model gateway, lists its
// models, reads its two point wallets, and presses its daily first-login grant
// (the 每日赠送积分 refresh). Request shapes are ported from aimod-cc/agent2api
// (MIT), providers/loomy, rewritten for magpie's plugin API. The password
// sign-in and the renewal of password accounts live in renew.mjs.

import { createHash, createHmac, randomUUID } from "node:crypto"

// password sign-in, where the password is kept, and the renewal paths. Its own
// file so that a merge of upstream's index.mjs never has to touch it; the
// wiring is the three lines marked "renewal" below.
import { loomyRenewal } from "./renew.mjs"

// extras: the onboarding tasks and the trace headers. Same reason as
// renew.mjs — the code lives outside this file so an upstream merge keeps
// only the call sites below.
import { extendLoomy, traceHeaders, shapeOf, WIRE_OPTION, WIRE_SWITCH } from "./extras.mjs"

// the attribution headers Loomy's own 0.9.39 client sends, measured from its
// traffic. Same reason as the two above: call sites stay here, shapes live there.
import { clientUserAgent, accountUserAgent, AXIOS_ACCEPT, chatAttribution, traceparent } from "./headers.mjs"

const ID = "loomy"
const NAME = "Loomy（讯飞）"

// the three planes (agent2api endpoints.rs; env-overridable the same way)
const env = (name, fallback) => {
  const v = process.env[name]?.trim()
  return v ? v.replace(/\/+$/, "") : fallback
}
const integrationBase = () => env("LOOMY_POINTS_BASE_URL", "https://loomyad.xunfei.cn")
// the account host is the Loomy client's own CAccount domain: it comes from
// the install package's encrypted .env.prod (VITE_XFYUN_BASE_URL, unpacked
// from app.asar with the client's own env-file-crypto.js) — xfinfr.com is
// xfyun's account infrastructure, not a third-party host (reference
// endpoints.rs, itself sourced from the installed client)
const xfyunBase = () => env("LOOMY_XFYUN_BASE_URL", "https://account.xfinfr.com")
const accessKeyId = () => env("LOOMY_XFYUN_ACCESS_KEY_ID", "2thryby66wxi53sk")
const accessKeySecret = () => env("LOOMY_XFYUN_ACCESS_KEY_SECRET", "zsak6eadrbawz683wf5r3m2snrwj868r")
const appId = () => env("LOOMY_XFYUN_APP_ID", "GM3LOOMY")
const modelBase = () => `${integrationBase()}/api/v1`

// business codes (agent2api client.rs): 000000 ok; 020002/100002 sign-in gone
const OK = "000000"
const AUTH_CODES = new Set(["020002", "100002"])

const REQUEST_TIMEOUT = 20_000

// the session the client asks for at sign-in (expire: 1209600, as Loomy's
// own client sends it); there is no endpoint that renews one
const SESSION_TTL = 14 * 86400e3

// when an account's session began: the time an SMS sign-in kept, else its
// 14-day end less 14 days (accounts signed in before 0.1.12); 0 when not
// known (a pasted session)
function signedInAt(a) {
  const at = Number(a?.signedInAt)
  if (Number.isFinite(at) && at > 0) return at
  const exp = Number(a?.expires)
  return Number.isFinite(exp) && exp > SESSION_TTL ? exp - SESSION_TTL : 0
}

// what a lapsed account says: the vendor refused the session, with the day
// it was signed in. No lifetime is claimed: the client asks for 14 days, but
// agent2api found sessions still served past that, so the day is the fact
// and the reader can set it beside the drop
function lapsedText(a, said) {
  const at = signedInAt(a)
  let when = ""
  if (at) {
    const d = new Date(at + 8 * 3600e3) // Beijing
    when = `；这次登录在 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`
  }
  return `Loomy 登录态已失效（${said || "code=100002"}${when}），请重新登录`
}


// the chat models the live /api/v1/models returned on 2026-10-16 (the image
// models come from the live list only; the loader draws with them through
// /images/generations, #609). The live list replaces or extends this —
// entries here only make the picker usable before the first sign-in.
const STATIC_MODELS = {
  "DeepSeek-V4.1-Flash": { name: "DeepSeek V4.1 Flash (x2.0)", limit: { context: 1_048_576, output: 384_000 } },
  "deepseek-v4-flash-0731": { name: "DeepSeek V4 Flash 0731 (x3.0)", limit: { context: 1_048_576, output: 384_000 } },
  "MiniMax-M3": { name: "MiniMax M3 (x4.0)", limit: { context: 1_048_576, output: 512_000 } },
  "Kimi-k2.6": { name: "Kimi k2.6 (x6.5)", limit: { context: 262_144, output: 65_536 } },
  "qwen-3.8-max": { name: "Qwen 3.8 Max (x12.0)", limit: { context: 1_000_000, output: 65_536 } },
  "GLM-5.3-Flash": { name: "GLM 5.3 Flash (x0.8)", limit: { context: 1_048_576, output: 131_072 } },
  "qwen3.8-flash": { name: "qwen 3.8 flash (x0.8)", limit: { context: 1_000_000, output: 131_072 } },
  "spark-x": { name: "Spark-X2.5 (限时免费) (x0.0)", limit: { context: 1_048_576, output: 65_536 } },
  "mimo-v2.5": { name: "MiMo V2.5 (x3.3)", limit: { context: 1_048_576, output: 131_072 } },
  auto: { name: "自动 · 均衡" },
}

// the client's _makeBase() envelope for the account domain
const makeBase = () => ({
  appid: appId(),
  modelid: "Web",
  version: "1.0.0",
  devid: "web",
  ua: "Loomy|Desktop|Electron|macOS",
  traceid: [...createHash("md5").update(randomUUID()).digest().slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join(""),
})

// ── small helpers ──────────────────────────────────────────────────────────

const toNum = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
const codeOf = (payload) => String(payload?.code ?? "").trim()
const messageOf = (payload) => String(payload?.desc ?? payload?.message ?? "").trim()

// The vendor's day is Beijing's: the daily grant is worth nothing after its
// midnight, so that is where the day's window says it renews.
const nextBeijingMidnight = (nowMs = Date.now()) => {
  const day = 24 * 3600e3
  const off = 8 * 3600e3
  return Math.floor((nowMs + off) / day) * day + day - off
}

const beijingMidnight = () => nextBeijingMidnight()


// totalOf is the account's whole credits as the window routing reads: the
// daily wallet (spent of its limit when the vendor tells the pair, else only
// what is left) and the permanent balance added up. Spent is what the daily
// wallet has spent; the permanent balance has nothing spent to tell, so the
// total is spent of spent + left, and with nothing left it is all used. It
// renews with the daily wallet at Beijing midnight, when the daily credits
// left are lost (runsOutAt, runsOut), so routing spends those first. With
// the daily credits spent and permanent ones left, midnight loses nothing,
// so the total names no reset: smart routing puts an account whose reset
// does lose credits first (plugins#1153). Used up, it names midnight, when
// it is back. null with neither wallet told.
function totalOf(dailyWallet, dailyLeft, permanent) {
  if (dailyLeft == null && permanent == null) return null
  const spent = dailyWallet?.amount ?? 0
  const left = Math.max(0, dailyLeft ?? 0) + Math.max(0, permanent ?? 0)
  const limit = spent + left
  const w = {
    name: "积分合计",
    used: limit > 0 ? (100 * spent) / limit : 100,
    display: `${left} credits left`,
    amount: spent,
    limit,
    unit: "credits",
  }
  if (dailyWallet) {
    // no span either: magpie reads a window with a span and no reset as
    // renewing a span from now, which would rank it again
    if (dailyLeft > 0 || left === 0) {
      w.resetsAt = beijingMidnight()
      if (dailyWallet.span) w.span = dailyWallet.span
    }
    if (dailyLeft > 0) Object.assign(w, { runsOutAt: w.resetsAt, runsOut: dailyLeft })
  }
  return w
}

class SignedOut extends Error {}
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

/**
 * 「内容太长了，请精简输入或开启新对话」 does not name 「上下文」, so magpie
 * versions before v0.1.2189 do not match it with `tooLongRe`
 * (`internal/gateway/gateway.go`): the try is filed as an error that rests the
 * account, the group's other members are never asked, and the whole turn fails.
 *
 * This rewrites the wording to one `tooLongRe` knows, so the agent compacts
 * instead of the turn failing. The status code is passed through unchanged:
 * whether the request is really over length or the upstream is merely busy is
 * not something this plugin can tell from the body, and guessing wrong (turning
 * a real overflow into a 502) makes magpie retry every account and end the turn
 * in 502.
 *
 * v0.1.2189 and later already match this wording in the host, so this is a
 * fallback for older hosts.
 *
 * ⚠ History: the 502 branch was removed on review. A fixed character threshold
 * knows nothing about the model's own window (Kimi-k2.6 is 262,144 tokens, but
 * 1.5M ASCII characters is already ~375k tokens), so it reported genuine
 * over-length requests as upstream failures — magpie then retried every account
 * and the turn ended in 502. This version only rewrites the wording; it never
 * changes the status.
 */
const TOO_LONG_SAID = /内容太长(了)?|内容过长/
const TOO_LONG_REWORDED = "上下文超出长度限制"

function retryableRefusal(status, body) {
  if (status !== 400 && status !== 413 && status !== 422) return null
  if (!TOO_LONG_SAID.test(body)) return null
  return new Response(body.replace(TOO_LONG_SAID, TOO_LONG_REWORDED), {
    status,
    headers: { "content-type": "application/json", "x-loomy-vendor-status": String(status) },
  })
}

// The gateway refuses a session with HTTP 200 and a business code, on the
// model paths as on the others: a made-up or dropped session on
// /api/v1/chat/completions, asked for a stream, got 200 application/json
// {"code":"100002","desc":"登录已失效，请重新登录"} (measured 2026-11-16).
// Passed through, that 200 was no answer for the agent, magpie didn't try
// the next account, and as a success it took the account's signed-out mark
// off, which the next usage read (100002) put back: the account was signed
// out and in again over and over (jenxingyoung on X, "轮着掉登录").
// So a JSON 200 with a code other than 000000 is a refusal: a sign-in code
// is a 401 that says the sign-in expired, and any other a 502 with the
// vendor's words. A model's own answer (an SSE stream, or a completion or
// a draw, neither of which has a top-level code) goes through as it came.
const REFUSAL_MAX = 64 << 10
async function businessRefusal(res, a) {
  const ct = res.headers.get("content-type") ?? ""
  if (!/json/i.test(ct) || /event-stream/i.test(ct)) return res
  const text = await res.text()
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  const same = () => new Response(text, { status: res.status, statusText: res.statusText, headers })
  if (text.length > REFUSAL_MAX) return same()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return same()
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return same()
  const code = codeOf(payload)
  if (!code || code === OK) return same()
  const said = messageOf(payload)
  if (AUTH_CODES.has(code)) {
    const r = errorResponse(401, lapsedText(a, said || `code=${code}`))
    r.headers.set("x-magpie-sign-in", "expired")
    return r
  }
  return errorResponse(502, `Loomy 拒绝了请求：${said || "无错误说明"}（code=${code}）`)
}

// The gateway's verdict on a session is its business code: a made-up,
// dropped or missing token gets HTTP 200 with 100002 on every path (chat,
// draw, models, points and first-login; measured 2026-11-16 and again
// 2026-11-17), never a 401 or a 403. A 401 or 403 that doesn't carry a
// sign-in code came from something on the way, a proxy or a firewall
// turning the exit address away, and says nothing about the session.
// Read as "signed out", it marked a good account for sign-in again
// whenever the user's proxy was refused, a different account each time
// (jenxingyoung on X: four accounts on a proxy, "今天这个掉，明天那个掉").
// So such a status is a failure of this try that leaves the sign-in as it
// is ("kept"), and only a sign-in code in its body says the session ended.
async function deniedStatus(res, a) {
  const text = await res.text().catch(() => "")
  let code = ""
  let said = ""
  try {
    const payload = JSON.parse(text)
    code = codeOf(payload)
    said = messageOf(payload)
  } catch {}
  if (AUTH_CODES.has(code)) {
    const r = errorResponse(401, lapsedText(a, said || `code=${code}`))
    r.headers.set("x-magpie-sign-in", "expired")
    return r
  }
  const r = errorResponse(502, deniedText(res.status, said || text))
  r.headers.set("x-magpie-sign-in", "kept")
  return r
}

function deniedText(status, said) {
  const words = String(said ?? "").replace(/\s+/g, " ").trim().slice(0, 300)
  return `Loomy 网关返回 HTTP ${status}，不是登录失效（Loomy 的登录失效是 HTTP 200 加业务码 100002），多半是代理或网络拦截了这次请求${words ? `：${words}` : ""}`
}

async function bodyText(input, init) {
  const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return typeof b === "string" ? b : new TextDecoder().decode(b)
}

// ── the account domain's HMAC-SHA1 signature (agent2api sign.rs, itself a
// copy of the client's electron/xfyun/sign.js). Nine parts, \n-joined; the
// last two (signed headers, canonicalized headers) are always empty here.
// This is client-fingerprint reproduction, not a security boundary.

function escapeSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase())
}
function escapedPath(path) {
  let clean = path.startsWith("/") ? path : `/${path}`
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1)
  return clean.split("/").map(escapeSegment).join("/")
}
function contentMD5(bodyString) {
  if (!bodyString) return ""
  return createHash("md5").update(bodyString).digest("base64")
}
function utcDateString() {
  return new Date().toUTCString()
}
function signHeaders(method, path, bodyString, shape = true) {
  const md5 = contentMD5(bodyString)
  const date = utcDateString()
  const nonce = randomUUID() // with hyphens, as the client signs it
  const stringToSign = [method.toUpperCase(), escapedPath(path), "", md5, "application/json", date, nonce, "", ""].join("\n")
  const signature = createHmac("sha1", accessKeySecret()).update(stringToSign).digest("base64")
  const headers = {
    Authorization: `account ${accessKeyId()}:${signature}`,
    Date: date,
    Nonce: nonce,
    "Content-Type": "application/json",
    // an axios-shaped call, which is what the client's account chain is.
    // Accept is not one of the nine signed parts, so adding it cannot break
    // the signature; only Content-Type is signed, and that is unchanged.
    // Both go and come with the shape switch (extras.mjs's WIRE_SWITCH).
    ...(shape ? { Accept: AXIOS_ACCEPT, "User-Agent": accountUserAgent() } : {}),
  }
  if (md5) headers["Content-MD5"] = md5
  return headers
}

// one signed POST on the account domain (the login chain); the signature
// must cover the exact bytes sent, so the body is serialized once here
async function signedPost(pathname, body, shape = true) {
  const bodyString = JSON.stringify(body)
  const res = await fetch(xfyunBase() + pathname, {
    method: "POST",
    headers: signHeaders("POST", pathname, bodyString, shape),
    body: bodyString,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
  const payload = await res.json().catch(() => null)
  if (!payload) throw new Error(`Loomy 账号接口返回了无法解析的内容（HTTP ${res.status}）`)
  if (!res.ok) throw new Error(`Loomy 账号接口返回 HTTP ${res.status}: ${messageOf(payload)}`)
  return payload
}

// one request on the integration gateway with the session header.
//
// Not every gateway path wants the same headers, and the client's own traffic
// shows they genuinely differ: /api/v1/models is asked for as JSON with an
// Accept and a Content-Type, while the two points paths send neither and take
// whatever Accept the runtime defaults to. `headers` per call is how those
// differences are expressed without a second function.
async function tokenRequest(method, path, session, body, opts = {}) {
  if (!session?.trim()) throw new SignedOut("Loomy 账号缺少 session")
  const init = {
    method,
    // `token` only, on the client's shape: the session header the Loomy
    // gateway reads, and the client sends no Authorization on these endpoints.
    // Off, upstream's pair applies — both headers — which is what
    // opts.upstream asks for. The Accept, where one is wanted, is the
    // caller's: that is where the shape switch is read.
    headers: {
      token: session,
      ...(opts.upstream ? { Authorization: `Bearer ${session}` } : {}),
      ...(opts.accept ? { Accept: opts.accept } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  } else if (opts.json) {
    // /api/v1/models is a GET that still declares its type in the client's
    // traffic — declared there, so declared here
    init.headers["Content-Type"] = "application/json"
  }
  const res = await fetch(integrationBase() + path, init)
  if (res.status === 401 || res.status === 403) {
    // only a sign-in code says the session ended (deniedStatus)
    const text = await res.text().catch(() => "")
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {}
    if (AUTH_CODES.has(codeOf(payload))) throw expired(messageOf(payload) || `code=${codeOf(payload)}`)
    throw new Error(deniedText(res.status, messageOf(payload) || text))
  }
  const payload = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`Loomy 接口返回 HTTP ${res.status}`)
  if (!payload) throw new Error("Loomy 接口返回了无法解析的内容")
  return payload
}


// a pasted session's account name: its last six characters, as the token
// tails other subscriptions show
function pastedName(session) {
  return `手动粘贴 ···${String(session).slice(-6)}`
}

// the phone number as the client normalizes it (agent2api login.rs)
function normalizePhone(raw) {
  const trimmed = String(raw ?? "").replace(/[\s-]/g, "")
  let digits = trimmed.replace(/^\+86/, "")
  if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2)
  if (/^1[3-9]\d{9}$/.test(digits)) return digits
  return null
}

// ── chat body adaptation ───────────────────────────────────────────────────

// the thinking levels Loomy's client offers are low/medium/high, and only
// those three: its picker is [low, medium, high] with medium the default, and
// "off" is sent as no field at all rather than as "none". A wider level the
// agent asked is folded into the top one, off/none and unknowns are left off
// (agent2api mod.rs reasoning_patch)
//
// xhigh folds to high, not away: magpie's effortOf passes xhigh through
// (internal/gateway/ir.go), and a plugin model declares no levels, so
// fitFor hands it over untouched (internal/gateway/decide.go). Dropping the
// field would ask for whatever the vendor defaults to — a silent downgrade
// from the strongest level, which is the one thing a fold must not do.
function foldReasoning(body) {
  let changed = false
  const of = (v) => {
    if (v === "minimal" || v === "low") return "low"
    if (v === "medium") return "medium"
    if (v === "high" || v === "xhigh" || v === "max") return "high"
    return null
  }
  if (typeof body.reasoning_effort === "string") {
    const folded = of(body.reasoning_effort)
    if (folded !== body.reasoning_effort) {
      if (folded) body.reasoning_effort = folded
      else delete body.reasoning_effort
      changed = true
    }
  }
  if (body.reasoning && typeof body.reasoning === "object" && typeof body.reasoning.effort === "string") {
    const folded = of(body.reasoning.effort)
    if (folded !== body.reasoning.effort) {
      if (folded) body.reasoning.effort = folded
      else delete body.reasoning.effort
      changed = true
    }
  }
  return changed
}

// the older deepseek models on Loomy (deepseek-v4-flash-0731) read
// images only as <image_base64> markers, not OpenAI image_url parts; their
// data-URI images are turned into the marker and merged into the text before
// them (agent2api images.rs). DeepSeek-V4.1-Flash takes image_url parts and
// reads the marker as plain text (10k prompt tokens, an empty reply), so it
// keeps the parts as sent (plugins#811), and so does deepseek-v4-flash-1017
// (plugins#1139). Loomy renames these freely, so only the old line the marker
// was made for gets it; any other DeepSeek id keeps OpenAI's shape.
function prefersTagFormat(model) {
  const m = String(model ?? "").toLowerCase().replace(/^.*\//, "")
  return /^deepseek-v4-flash(?:-0731)?$/.test(m)
}
function toTagText(part) {
  const kind = String(part?.type ?? "").trim().toLowerCase()
  if (kind !== "image_url" && kind !== "input_image") return null
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url
  if (typeof url !== "string" || !url.startsWith("data:")) return null
  return `<image_base64>${url}</image_base64>`
}
function rewriteImagesToTags(body) {
  let converted = 0
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (let i = message.content.length - 1; i >= 0; i--) {
      const tag = toTagText(message.content[i])
      if (!tag) continue
      message.content.splice(i, 1)
      const prev = i > 0 && message.content[i - 1]?.type === "text" ? message.content[i - 1] : null
      if (prev) prev.text += `\n${tag}`
      else if (message.content[i]?.type === "text") message.content[i].text = `${tag}\n${message.content[i].text}`
      else message.content.splice(i, 0, { type: "text", text: tag })
      converted++
    }
  }
  return converted
}

// the vendor's /models: OpenAI-shaped entries whose capabilities say what a
// model does, and whose display name ends in its point rate "(x3.0)"
// (agent2api models.rs)
function splitRateSuffix(name) {
  const trimmed = String(name ?? "").trimEnd()
  for (const [close, open] of [
    [")", "("],
    ["）", "（"],
  ]) {
    if (!trimmed.endsWith(close)) continue
    const body = trimmed.slice(0, -1)
    const at = body.lastIndexOf(open)
    if (at < 0) continue
    const inner = body.slice(at + 1).trim()
    if (!/^x\d+(\.\d+)?$/i.test(inner)) return { name: trimmed, rate: undefined }
    const bare = body.slice(0, at).trimEnd()
    return { name: bare || trimmed, rate: inner.toLowerCase() }
  }
  return { name: trimmed, rate: undefined }
}
function catalogModel(entry) {
  const id = String(entry?.id ?? "").trim()
  if (!id) return null
  // a non-chat entry (an image model, say) is not something the picker can
  // route a completion to; the vendor's /models mixes them in (modelmux
  // PROTOCOL.md 3.3, xux23's port). An entry with no type is kept: the live
  // list has been seen both ways.
  const kind = String(entry?.type ?? "").trim().toLowerCase()
  if (kind && kind !== "chat") return null
  const caps = entry?.capabilities ?? {}
  const { name, rate } = splitRateSuffix(entry?.name ?? entry?.display_name ?? id)
  const config = { name: name || id }
  const limit = {}
  const context = toNum(entry?.context_window ?? entry?.context_length ?? entry?.limit?.context)
  // the catalogue names the output cap `max_output_tokens` — the client's own
  // mapper reads limit.output, then max_output_tokens, then max_completion_tokens
  // (A9 in its bundle), and two independent ports of the same catalogue agree
  // (loomy2api's PROTOCOL.md and its max_output_tokens()). `max_tokens` is kept
  // last only because an entry carrying it costs nothing to read.
  const output = toNum(entry?.limit?.output ?? entry?.max_output_tokens ?? entry?.max_completion_tokens ?? entry?.max_tokens)
  if (context != null) limit.context = context
  if (output != null) limit.output = output
  if (Object.keys(limit).length) config.limit = limit
  if (caps.reasoning) config.reasoning = true
  if (caps.function_calling) config.tool_call = true
  if (caps.vision) config.modalities = { input: ["text", "image"], output: ["text"] }
  if (rate) config.rate = rate
  return { id, config }
}

// listedModel is the vendor's entry as the models hook gives it: the config's
// fields, and the capabilities the host reads a listed model by. The config's
// fields alone left the vendor's vision, reasoning and tool calls unread:
// magpie's host reads a listed model by capabilities.input.image,
// capabilities.reasoning and capabilities.toolcall (host.js rowOf, the model
// row it sends magpie), and the config's own spellings (modalities, reasoning,
// tool_call) are only converted on the config hook's path (host.js info),
// never on what a models hook gives back. So deepseek-v4-flash-1017, which
// models.dev doesn't know, went as a text-only model of no reasoning and no
// tool calls (plugins#1141). What the vendor doesn't say keeps what was known
// of the model (models.dev, the static table).
function listedModel(was, m, entry) {
  const caps = entry?.capabilities ?? {}
  const had = was?.capabilities ?? { temperature: true, toolcall: true, input: { text: true }, output: { text: true } }
  const capabilities = { ...had, input: { ...(had.input ?? { text: true }) } }
  if (typeof caps.reasoning === "boolean") capabilities.reasoning = caps.reasoning
  if (typeof caps.function_calling === "boolean") capabilities.toolcall = caps.function_calling
  if (typeof caps.vision === "boolean") {
    capabilities.input.image = caps.vision
    capabilities.attachment = caps.vision
  }
  const limit = { ...(was?.limit ?? {}), ...(m.config.limit ?? {}) }
  return {
    ...(was ?? {}),
    ...m.config,
    id: m.id,
    ...(Object.keys(limit).length ? { limit } : {}),
    capabilities,
  }
}

// ── the plugin ─────────────────────────────────────────────────────────────

export async function LoomyAuthPlugin({ client, magpie } = {}) {
  const methods = []
  // The request shape the Loomy client asks with, read per request so a switch
  // flipped in magpie's editor reaches the next one without a restart
  // (extras.mjs's WIRE_SWITCH). OpenCode passes no magpie at all, and there the
  // shape stays the client's — which is what the switch asks for (shapeOf).
  const shape = () => shapeOf(magpie)
  // renewal (password sign-in, credential keeping, the two renewal paths) —
  // it adds its method to `methods` and wraps the hooks when they are returned
  const renewal = loomyRenewal({
    client,
    // the shape read per call, so renewal's two account requests carry it too
    signedPost: (path, body) => signedPost(path, body, shape()),
    makeBase,
    codeOf,
    messageOf,
    normalizePhone,
    OK,
    AUTH_CODES,
    ID,
  })

  methods.push({
    type: "oauth",
    label: "短信验证码登录（SMS sign-in）",
    prompts: [{ type: "text", key: "phone", message: "手机号（中国大陆 11 位）", validate: (v) => (normalizePhone(v) ? undefined : "请填写 11 位中国大陆手机号") }],
    authorize: async (inputs) => {
      const phone = normalizePhone(inputs?.phone)
      if (!phone) return { type: "failed", error: "请填写 11 位中国大陆手机号" }
      // send the code now; the code the user pastes next completes it
      let msgid
      try {
        const sent = await signedPost("/login/phone/sendMsgCode", { base: makeBase(), param: { ccode: "86", phone, expire: 300 } }, shape())
        if (codeOf(sent) !== OK) return { type: "failed", error: `验证码发送失败：${messageOf(sent) || `code=${codeOf(sent)}`}` }
        msgid = sent?.data?.msgid
        if (!msgid) return { type: "failed", error: "验证码发送成功但上游没有返回 msgid" }
      } catch (e) {
        return { type: "failed", error: String(e?.message ?? e) }
      }
      return {
        url: "",
        instructions: `验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)}，请输入收到的 6 位验证码。`,
        method: "code",
        callback: async (code) => {
          const mcode = String(code ?? "").trim()
          if (!/^\d{6}$/.test(mcode)) return { type: "failed", error: "请输入 6 位数字验证码" }
          try {
            const answer = await signedPost("/login/phone/checkCode", {
              base: makeBase(),
              param: { ccode: "86", phone, mcode, msgid, expire: 1209600 },
            }, shape())
            if (AUTH_CODES.has(codeOf(answer)))
              return { type: "failed", error: "登录失败：登录态已失效，请重新获取验证码" }
            if (codeOf(answer) !== OK) return { type: "failed", error: `登录失败：${messageOf(answer) || `code=${codeOf(answer)}`}` }
            const session = String(answer?.data?.session ?? "").trim()
            if (!session) return { type: "failed", error: "登录成功但上游没有返回 session" }
            const userId = String(answer?.data?.userid ?? "")
            const now = Date.now()
            return {
              type: "success",
              refresh: "",
              access: session,
              expires: now + SESSION_TTL, // the session the client asks for is 14 days
              signedInAt: now,
              accountId: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
              // two phones masked alike stay two accounts (magpie's host
              // tells accounts of one name apart by uid)
              ...(userId ? { uid: userId } : {}),
              userId,
              source: "sms",
            }
          } catch (e) {
            return { type: "failed", error: String(e?.message ?? e) }
          }
        },
      }
    },
  })
  methods.push({
    type: "oauth",
    label: "手动粘贴 session（Paste token）",
    prompts: [{ type: "text", key: "session", message: "session（token 头的值，14 天有效）", validate: (v) => (v && v.trim() ? undefined : "必填") }],
    // an oauth authorize() hands back {url, method, instructions, callback}
    // and the host finishes the sign-in by calling callback() — returning
    // the account directly leaves the host on a callback that doesn't exist
    authorize: async (inputs) => {
      const session = String(inputs?.session ?? "").trim()
      if (!session) return { type: "failed", error: "session 必填" }
      return {
        url: "",
        instructions: "已取到粘贴的 session，确认即完成登录。",
        method: "auto",
        // each pasted session its own name: magpie's host keeps one account
        // per name, so one name for every paste put a second pasted account
        // over the first, and signing one in again dropped another
        callback: async () => ({ type: "success", refresh: "", access: session, expires: 0, accountId: pastedName(session), source: "manual" }),
      }
    },
  })

  // renewal: the password method, refreshLead/refresh, and the 401 fallbacks
  // on loader/usage/checkin. Everything below is upstream's, unchanged.
  // extras: the one-time onboarding tasks ride along with the daily grant
  // inside auth.checkin, so nothing else has to know they exist. Everything
  // else above is upstream's, unchanged — see extras.mjs for why.
  const wired = renewal.extend({
    auth: {
      provider: ID,
      // the request-shape switch (extras.mjs's WIRE_SWITCH), drawn by magpie
      // in the provider's editor; OpenCode ignores it, and there the shape
      // stays the client's, which is what the switch asks for
      options: [WIRE_OPTION],
      // Loomy hands out no refresh token: a session lives 14 days. Password
      // accounts are renewed by renew.mjs (auth.refresh, and the 401 fallback
      // in the loader below); SMS and pasted ones are still sign-in-only
      async loader(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth") return {}
        // draw sends magpie's images request to the same gateway's
        // /images/generations with the session, as #609's reporter measured:
        // 200 {"created":…,"data":[{"url":…}],"points_consumed":110}. The
        // answer is plain JSON, so it is asked for as JSON, not as a stream;
        // the body goes as magpie wrote it (the chat path's rewrites are
        // about messages, which a draw has none of)
        const draw = async (body, signal) => {
          const now = (await getAuth()) ?? a
          const session = now?.access ?? a.access
          if (!session) return errorResponse(401, "Loomy 登录态缺失，请重新登录")
          let res
          try {
            res = await fetch(`${modelBase()}/images/generations`, {
              method: "POST",
              headers: {
                // the same switch as the chat path's, header for header
                "Content-Type": shape() ? "application/json" : "application/json;charset=utf-8",
                Accept: "application/json",
                token: session,
                Authorization: `Bearer ${session}`,
                ...(shape()
                  ? {
                      // the client's draw carries traceparent but no
                      // loomy-version (its image path never calls
                      // withLoomyVersionHeader), so traceHeaders() — which
                      // returns the pair — is not used here
                      traceparent: traceparent(),
                      "user-agent": clientUserAgent(),
                      "x-loomy-request-purpose": "image.generate",
                    }
                  : {}),
              },
              body,
              signal,
            })
          } catch (e) {
            return errorResponse(502, e?.message ?? String(e))
          }
          if (res.status === 401 || res.status === 403) return deniedStatus(res, now)
          if (!res.ok) {
            const raw = await res.text().catch(() => "")
            return errorResponse(res.status, `Loomy 上游返回 ${res.status}: ${raw.slice(0, 4096) || "无错误说明"}`)
          }
          return businessRefusal(res, now)
        }
        return {
          baseURL: modelBase(),
          apiKey: "loomy",
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const pathname = new URL(url).pathname
            if (/\/images\/generations$/.test(pathname)) return draw(await bodyText(input, init), init.signal)
            // /images/edits is not served: magpie sends an edit to a plugin
            // as multipart (internal/gateway/draw.go drawImages), and no one
            // has measured what Loomy's gateway takes for one (#609)
            if (!/\/chat\/completions$/.test(pathname))
              return errorResponse(404, "only chat completions and image generations are served")
            let chat
            try {
              chat = JSON.parse(await bodyText(input, init))
            } catch {
              return errorResponse(400, "a request that isn't JSON")
            }
            const now = (await getAuth()) ?? a
            const session = now?.access ?? a.access
            if (!session) return errorResponse(401, "Loomy 登录态缺失，请重新登录")

            // the body as Loomy's own client writes it: reasoning folded to
            // its three levels, and the old deepseek line's images as base64
            // markers (V4.1-Flash keeps its image_url parts, plugins#811)
            try {
              foldReasoning(chat)
              if (prefersTagFormat(chat.model)) rewriteImagesToTags(chat)
            } catch {}
            let res
            try {
              // The client's shape when the switch is on, upstream's when it
              // is off (extras.mjs's WIRE_SWITCH): the two differ in five
              // headers and nothing else here.
              const clientShape = shape()
              res = await fetch(`${modelBase()}/chat/completions`, {
                method: "POST",
                headers: {
                  // bare application/json, as the client's own traffic has it:
                  // the body it sends carries CJK text and the vendor answers
                  // 200, so the charset parameter was never load-bearing
                  "Content-Type": clientShape ? "application/json" : "application/json;charset=utf-8",
                  // opencode's own request on the imodel plane arrives with
                  // */*, and the vendor streams SSE regardless
                  Accept: clientShape ? "*/*" : "text/event-stream",
                  // the session travels as Authorization here, and NOT as
                  // `token`: the client sends one or the other depending on
                  // the plane, and the chat plane is the Bearer one
                  Authorization: `Bearer ${session}`,
                  ...(clientShape ? {} : { token: session }),
                  ...(clientShape ? chatAttribution(init.headers, chat) : {}),
                  // the client's own tracing pair; see extras.mjs traceHeaders
                  ...(clientShape ? traceHeaders() : {}),
                },
                body: JSON.stringify(chat),
                signal: init.signal,
              })
            } catch (e) {
              return errorResponse(502, e?.message ?? String(e))
            }
            if (res.status === 401 || res.status === 403) return deniedStatus(res, now)
            if (!res.ok) {
              const raw = await res.text().catch(() => "")
              const refusal = retryableRefusal(res.status, raw)
              if (refusal) return refusal
              return errorResponse(res.status, `Loomy 上游返回 ${res.status}: ${raw.slice(0, 4096) || "无错误说明"}`)
            }
            // the answer streams through as it came (OpenAI-shaped); a 200
            // that is a refusal in the vendor's envelope is said as one
            return businessRefusal(res, now)
          },
        }
      },
      async usage(getAuth) {
        let a
        try {
          a = await getAuth()
          if (a?.type !== "oauth") return { error: "not signed in", signIn: "kept" }
          const payload = await tokenRequest("GET", "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat", a.access, undefined, { accept: shape() ? "*/*" : undefined, upstream: !shape() })
          const code = codeOf(payload)
          if (AUTH_CODES.has(code)) return { error: lapsedText(a, messageOf(payload) || `code=${code}`), signIn: "expired" }
          if (code !== OK) return { error: `积分查询失败：${messageOf(payload) || `code=${code}`}`, signIn: "kept" }
          const data = payload?.data?.data ?? payload?.data ?? {}
          const daily = toNum(data.dailyBalance)
          const permanent = toNum(data.balance)
          // this endpoint is a records list, so a reply without the balance
          // fields is a realistic case — "unknown" must not read as a
          // confident zero
          const dailyLimit = toNum(data.dailyLimitPoints)
          const dailyRemaining = toNum(data.dailyRemainingPoints)
          const pairPresent = dailyLimit != null && dailyRemaining != null
          if (daily == null && permanent == null && !pairPresent)
            return { error: `积分响应没有返回余额字段（${JSON.stringify(data).slice(0, 120)}）`, signIn: "kept" }
          // the daily wallet from the vendor's own numbers: spent is
          // dailyLimitPoints - dailyRemainingPoints. When the pair is absent
          // the wallet is an amount with no limit — a made-up limit would
          // always read as full
          //
          // In magpie's window, `used` is the share spent (0–100) and
          // `amount` the credits spent of `limit` (plugins#889): sent as a
          // count and as what was left, a percentage cap read 800 spent as
          // 800% and an amount cap compared the credits left with the cap
          const dailySpent = dailyLimit != null && dailyRemaining != null ? Math.min(dailyLimit, Math.max(0, dailyLimit - dailyRemaining)) : null
          const dailyWallet =
            dailyLimit != null && dailyRemaining != null
              ? { name: "每日赠送积分", used: dailyLimit > 0 ? (100 * dailySpent) / dailyLimit : 0, amount: dailySpent, limit: dailyLimit, unit: "credits", resetsAt: beijingMidnight(), span: 86400 }
              : daily != null
                ? { name: "每日赠送积分", used: 0, display: `${daily} credits` }
                : null
          // the permanent wallet comes back as a balance alone, with no
          // total and nothing spent, so on its own there is no share or
          // spent amount a cap could read
          const permanentWallet = permanent != null ? { name: "永久积分", used: 0, display: `${permanent} credits` } : null
          const windows = [...(dailyWallet ? [dailyWallet] : []), ...(permanentWallet ? [permanentWallet] : [])]
          // A request draws the daily credits first and the permanent ones
          // after, so the account stops only when both are gone (gocccy0 on
          // X): the daily wallet as the window that stops it held an account
          // with permanent credits left, and the permanent one as text alone
          // left routing nothing to read. So routing reads one window, the two
          // added up (totalOf), and the two wallets are shown beside it, set
          // aside, as WorkBuddy's plan and extra credits are.
          const total = totalOf(dailyWallet, dailyLimit != null && dailyRemaining != null ? dailyRemaining : daily, permanent)
          if (total) {
            for (const w of windows) w.aside = true
            windows.unshift(total)
          }
          // no `signIn` on a clean read: that absence is how magpie takes an
          // expired mark back off the account (a "kept" here would leave a
          // transient 401's lapse on forever)
          return { plan: NAME, user: a.name || a.accountId, windows }
        } catch (e) {
          if (e?.signIn === "expired") return { error: lapsedText(a, e.message), signIn: "expired" }
          return { error: String(e?.message ?? e), signIn: "kept" }
        }
      },
      // the daily grant: the first login of the vendor's day refreshes the
      // daily wallet; the same call pressed here keeps it refreshed for an
      // account that isn't logging in (agent2api checkin.rs). The endpoint
      // answers success whether it granted or not, so claimed vs done is
      // decided by the daily balance around the call: up means the day's
      // grant landed, flat means it was already in (or carries no daily
      // wallet) — "done", with the refreshed balance in the message either way
      async checkin(getAuth) {
        const a = await getAuth()
        if (a?.type !== "oauth" || !a.access) throw new SignedOut("Loomy：未登录")
        const readDaily = async () => {
          const rec = await tokenRequest("GET", "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat", a.access, undefined, { accept: shape() ? "*/*" : undefined, upstream: !shape() })
          return toNum(rec?.data?.data?.dailyBalance ?? rec?.data?.dailyBalance)
        }
        let before
        try {
          before = await readDaily()
        } catch (e) {
          if (e?.signIn === "expired" || e instanceof SignedOut) throw expired("Loomy 登录态已失效，无法刷新每日积分（请重新登录）")
          // without the pre-read there is no honest claimed/done verdict —
          // say failed with the reason rather than "already done"
          return { outcome: "failed", message: `无法读取签到前余额，未执行每日刷新：${e?.message ?? e}` }
        }
        let payload
        try {
          payload = await tokenRequest("POST", "/api/v1/points/first-login", a.access, {}, { accept: shape() ? "*/*" : undefined, upstream: !shape() })
        } catch (e) {
          if (e?.signIn === "expired" || e instanceof SignedOut) throw expired("Loomy 登录态已失效，无法刷新每日积分（请重新登录）")
          return { outcome: "failed", message: `每日积分刷新失败：${e?.message ?? e}` }
        }
        const code = codeOf(payload)
        if (AUTH_CODES.has(code)) throw expired("Loomy 登录态已失效，无法刷新每日积分（请重新登录）")
        if (code !== OK) return { outcome: "failed", message: `每日积分刷新失败：${messageOf(payload) || `code=${code}`}` }
        const after = toNum(payload?.data?.dailyBalance ?? payload?.data?.data?.dailyBalance) ?? (await readDaily().catch(() => null))
        const dailyMsg = after != null ? `每日赠送积分已刷新（当前 ${after}）` : "每日赠送积分已刷新"
        if (before != null && after != null && after > before) return { outcome: "claimed", credit: after - before, message: `${dailyMsg}；今日首登奖励 +${after - before}` }
        return { outcome: "done", message: dailyMsg }
      },
      methods,
    },
    async config(config) {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      // the static table (captured from the live endpoint) keeps the picker
      // usable before the first sign-in; the models hook extends it from
      // /api/v1/models once signed in
      config.provider[ID] = {
        name: NAME,
        npm: "@ai-sdk/openai-compatible",
        api: modelBase(),
        ...was,
        models: { ...STATIC_MODELS, ...(was.models ?? {}) },
      }
    },
    provider: {
      id: ID,
      async models(p, { auth } = {}) {
        if (auth?.type !== "oauth" || !auth.access) return p.models
        try {
          const payload = await tokenRequest("GET", "/api/v1/models", auth.access, undefined, shape() ? { accept: "application/json", json: true } : { upstream: true })
          // a refusal in a 200 lists nothing: what was given (the static
          // table at first) isn't the account's list, so magpie keeps the
          // one it had and the models picked from it
          if (codeOf(payload) && codeOf(payload) !== OK) return fellBack(p.models)
          const entries = Array.isArray(payload?.data) ? payload.data : []
          for (const entry of entries) {
            const m = catalogModel(entry)
            if (!m) continue
            p.models[m.id] = listedModel(p.models[m.id], m, entry)
          }
          return p.models
        } catch {
          return fellBack(p.models)
        }
        return p.models
      },
    },
  })

  return extendLoomy(wired)
}

// fellBack marks a list that isn't the account's own (magpie's plugin
// host reads Symbol.for("magpie.fellBack"))
function fellBack(models) {
  return Object.defineProperty(models, Symbol.for("magpie.fellBack"), { value: true, configurable: true })
}

// for tests
export const _internal = {
  retryableRefusal,
  businessRefusal,
  ID,
  NAME,
  STATIC_MODELS,
  signHeaders,
  escapedPath,
  contentMD5,
  foldReasoning,
  prefersTagFormat,
  rewriteImagesToTags,
  totalOf,
  splitRateSuffix,
  catalogModel,
  listedModel,
  normalizePhone,
  makeBase,
  toNum,
  nextBeijingMidnight,
  WIRE_SWITCH,
  shapeOf,
  beijingMidnight,
  totalOf,
}
