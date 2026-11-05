// The request attribution headers Loomy's own 0.9.39 client sends on the
// integration gateway, rebuilt here so the plugin's traffic is shaped the
// same way. Kept in its own file for the same reason renew.mjs and extras.mjs
// are: a merge of upstream's index.mjs then touches call sites, not logic.
//
// Everything below was measured, not guessed. The evidence is the client's own
// traffic recorded through its built-in LLM proxy
// (.sandbox/loomy-captures/real-windows*/llm-proxy.pretty/), cross-checked
// against the shipped source unpacked from app.asar. Where a value could not
// be confirmed it is not invented here — see the notes on each constant.

import { createHash, randomUUID } from "node:crypto"

// The user-agent a request from opencode carries. opencode launches its bun
// with `--user-agent=opencode/<version>`, and @ai-sdk/openai-compatible then
// suffixes the provider-utils and runtime segments, so the exact string is a
// function of opencode's own version. magpie's host runs bun with no UA flag
// (internal/plugin/bun.go bunCommand), so without this a plugin request
// arrives as `Bun/1.4.2` — a fingerprint no Loomy client ever produces.
//
// ⚠ This pins the opencode version. When magpie's bundled opencode moves, this
// string has to move with it or it becomes its own tell. LOOMY_CLIENT_UA
// overrides it for a build that knows better.
const DEFAULT_CLIENT_UA = "opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13"
export const clientUserAgent = () => process.env.LOOMY_CLIENT_UA?.trim() || DEFAULT_CLIENT_UA

// the account domain is reached by the client's axios, not by opencode, and
// the captured sign-in calls carry axios' own UA
const AXIOS_UA = "axios/1.21.0"
export const accountUserAgent = () => process.env.LOOMY_ACCOUNT_UA?.trim() || AXIOS_UA

// axios asks for this on every request it makes (electron/xfyun/* uses
// axios with no Accept override), and the captured sign-in calls show it
export const AXIOS_ACCEPT = "application/json, text/plain, */*"

// ── session identity ───────────────────────────────────────────────────────
//
// The client keeps a sessionId -> chatId map on disk (electron/chat-session-store.js),
// so its chatid is a random UUIDv4 that is stable for the life of a session and
// unrelated to anything the server can recompute. magpie's own conversationID
// is `magpie-<sha256 of the opening message>`, a shape no Loomy client emits —
// sending that would be a fingerprint on its own. So the chatid is derived from
// magpie's session id instead: stable for a session, and shaped like the real one.

function uuidV4From(seed) {
  const h = createHash("sha256").update(seed).digest("hex")
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// a request header may arrive as a plain object, a Headers, or an array of
// pairs depending on who called the loader
function headerValue(headers, name) {
  if (!headers) return undefined
  const want = name.toLowerCase()
  if (typeof headers.get === "function") return headers.get(want) ?? undefined
  if (Array.isArray(headers)) {
    for (const pair of headers) if (String(pair?.[0]).toLowerCase() === want) return pair[1]
    return undefined
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v
  return undefined
}

// magpie sends the opencode session as x-magpie-session, and *only* to a
// plugin's fetch hook — host.js strips it from anything the plugin sends back
// out (MAGPIE_ONLY), which is why x-session-affinity has to be a copy under a
// different name rather than a pass-through. opencode calling the plugin
// directly supplies it under its own name. These two are the only names that
// appear in a capture or in magpie's source; nothing else is guessed at.
const SESSION_HEADERS = ["x-magpie-session", "x-session-affinity"]

export function sessionIdOf(headers) {
  for (const name of SESSION_HEADERS) {
    const v = headerValue(headers, name)
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return undefined
}

// ── x-session-affinity ─────────────────────────────────────────────────────
//
// The client sends its own harness's session id, and every captured request
// carries one: `ses_` + 12 hex + 14 base62. That is opencode's own id layout
// (magpie mints the same shape in internal/provider/opencode_client.go), and
// all 8 captured values have it — 30 characters, the low 12 bits a small
// inverted counter.
//
// A plugin cannot choose who calls it, so the value it is handed may be any
// agent's: opencode's `ses_…`, Claude Code's `cc-7b2f1a8e-4d3c`, a bare uuid,
// or nothing at all. Passing that through does two bad things and one broken
// one:
//   • it names the harness that asked, which is the opposite of the point of
//     this whole change — `cc-…` is a shape no Loomy client ever emits;
//   • it is a format the vendor never sees, so any check on it fails loudly;
//   • a non-ASCII value makes `new Headers()` throw, and the request dies
//     locally as a 502 before it is ever sent (measured, not assumed).
//
// So a value opencode itself could have minted goes through untouched — the
// mainstream case, byte-identical to the client — and anything else is derived
// into that shape. Both directions are one-way, and nothing has to come back:
// the vendor echoes no session id at all. The 8 captures' response headers are
// server/date/content-type/transfer-encoding/connection/cache-control, the SSE
// bodies carry only the vendor's own `cht…@dx…` chunk ids, and the client's own
// bundle has no `x-session-affinity` string in it — it never reads the value
// back, it only sends it.
const SESSION_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// True for an id opencode could have made. The low 12 bits are its counter,
// inverted, so a real one is small — magpie's openCodeRealSession and
// zen-free's realSessionID test exactly this, because Zen's free tier answers
// 403 to a session id it does not recognise as opencode's.
export function isSessionId(value) {
  if (typeof value !== "string" || !SESSION_ID.test(value)) return false
  return 0xfff - Number.parseInt(value.slice(13, 16), 16) < 16
}

// An id of that shape, derived from seed: stable for a seed, different across
// seeds, and carrying a small counter of its own so it passes the same check a
// real one does. Pure derivation, so no map is kept and nothing can drift.
export function sessionAffinityOf(seed) {
  const h = createHash("sha256").update(`affinity:${seed}`).digest()
  const hex = h.toString("hex").slice(0, 9) + (0xfff - (h[0] & 0xf)).toString(16).padStart(3, "0")
  let tail = ""
  for (let i = 1; i <= 14; i++) tail += BASE62[h[i] % 62]
  return `ses_${hex}${tail}`
}

// The conversation a request is of, as a seed for the two session-scoped ids:
// the session the caller named when there is one, else the opening message —
// the same fallback magpie's own conversationID makes when an agent names no
// session (internal/gateway/gateway.go). undefined only when neither exists.
export function conversationSeed(headers, body) {
  const named = sessionIdOf(headers)
  if (named) return named
  const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
  const first = messages.find((m) => m?.role === "user") ?? messages[0]
  const opening = openingText(first)
  return opening ? `opening:${opening}` : undefined
}

// Only the words of the first turn name it. An image part carries its base64
// inline — one captured request's opening user message is 533,439 bytes — and
// copying that on every request is exactly the allocation magpie's own
// conversationID goes out of its way to avoid ("the turns are the body's own
// bytes, not a copy of each"). Capped too, so a long paste costs nothing.
const OPENING_MAX = 4096

function openingText(message) {
  if (!message || typeof message !== "object") return ""
  const parts = Array.isArray(message.content) ? message.content : [message.content]
  let s = String(message.role ?? "")
  for (const p of parts) {
    const t = typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""
    if (t) s += `\u0000${t}`
    if (s.length >= OPENING_MAX) break
  }
  return s.slice(0, OPENING_MAX)
}

// chatid is per session; msgid/turnid are per request (the client reuses the
// msgid across a retry of the same turn, so it is minted once per fetch)
export function chatIdFor(sessionId) {
  if (!sessionId) return undefined
  return `chat-${uuidV4From(`chat:${sessionId}`)}`
}

export function newMessageId() {
  return `msg-${randomUUID()}`
}

// ── the header sets ────────────────────────────────────────────────────────
//
// The client's own rules (electron/utils/request-headers.js):
//   • traceparent goes on every gateway call
//   • ChatId/MsgId/TurnId are bare camel-case and may be absent — "缺失是常态"
//   • TurnId is the MsgId of the turn, not a separate value
//   • InvokeOrigin is user or system
//   • X-Loomy-Request-Purpose is dropped rather than guessed: the client's own
//     note is 「宁可不发头，也不要发一个服务端不认识的值」
//
// The client uses one of 17 purposes and either origin, because it knows
// whether a request is a chat, a title, a memory extraction. A plugin is
// handed a chat completion and nothing else, so the two values below are the
// only honest ones — not a choice. The full list of 17 is in README.fork.md.

export function traceparent() {
  const trace = randomUUID().replace(/-/g, "")
  const span = randomUUID().replace(/-/g, "").slice(0, 16)
  return `00-${trace}-${span}-01`
}

// what a chat request carries besides auth. body is the parsed chat body, used
// only to name the conversation when the caller named none.
export function chatAttribution(headers, body) {
  const out = { "user-agent": clientUserAgent() }
  const named = sessionIdOf(headers)
  const seed = conversationSeed(headers, body)
  if (seed) {
    // a value opencode could have minted is sent as it is (that is the
    // mainstream case, and the client's own shape); anything else is derived
    // into that shape rather than passed through
    out["x-session-affinity"] = named && isSessionId(named) ? named : sessionAffinityOf(seed)
    out.chatid = chatIdFor(seed)
  }
  // a turn's ids travel together or not at all
  const msgId = newMessageId()
  out.msgid = msgId
  out.turnid = msgId
  out.invokeorigin = "user"
  out["x-loomy-request-purpose"] = "chat.message"
  return out
}
