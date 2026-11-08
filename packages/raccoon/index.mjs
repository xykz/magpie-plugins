// OpenCode & Magpie provider plugin for SenseTime Raccoon (商汤小浣熊, xiaohuanxiong.com).
//
// Raccoon signs in through xiaohuanxiong.com's desktop authorization page
// (/code/authorize -> office-raccoon://auth/callback?code=...&state=...), or
// reads the live session Raccoon's desktop app keeps in its auth.json
// (read-only; desktopAuthCandidates lists where). Chats are OpenAI-compatible
// chat completions at /api/web/llm/v2/chat/completions.

import { randomUUID, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// extras: the phone-side grant, the check-in triage, the vision whitelist,
// extra_body.thinking, the max_tokens floor and the refresh_conflict heal.
// Its own file so an upstream merge keeps only the wiring at the bottom.
import { extendRaccoon } from "./extras.mjs"

const PROVIDER_ID = "raccoon"
const PROVIDER_NAME = "商汤小浣熊"
const NPM = "@ai-sdk/openai-compatible"

const mainOrigin = () => (process.env.RACCOON_MAIN_SITE_URL || "https://xiaohuanxiong.com").replace(/\/+$/, "")
const authBase = () => (process.env.RACCOON_AUTH_API_BASE || `${mainOrigin()}/api/web/auth/v1`).replace(/\/+$/, "")
const llmBase = () => (process.env.RACCOON_LLM_BASE_URL || `${mainOrigin()}/api/web/llm/v2`).replace(/\/+$/, "")

const EARLY_MS = 60 * 1000
const LEAD_MS = 5 * 60 * 1000
const KEEP_RENEWED_MS = 60 * 1000
const CATALOG_TTL_MS = 10 * 60 * 1000

// USER_AGENT is what the vendor's chat API is asked with. magpie sends its own
// (`magpie/<version>`, internal/gateway/user_agent.go), and a plugin can't take
// that back: a plugin's provider has an Account, so provider.PassesUserAgent is
// false, and its Account.sign is a no-op (internal/provider/plugins.go), so
// neither `user-agent=agent` nor the provider's `header.User-Agent` reaches the
// request. So the fetch below puts this one on, over whatever magpie handed in.
// RACCOON_USER_AGENT overrides it, "" leaves magpie's own alone.
const USER_AGENT = "AsyncOpenAI/Python 2.8.0"
const userAgent = () => process.env.RACCOON_USER_AGENT ?? USER_AGENT

const desktopPlatform = (plat = process.platform) => (plat === "darwin" ? "desktop-mac" : "desktop-windows")
const desktopHeaders = () => ({
  "X-Client-Platform": desktopPlatform(),
  "X-Client-Version": "v1.0.0",
})

const FALLBACK_MODELS = [
  { id: "raccoon-8c4485", name: "Raccoon-Work", context: 1_000_000, output: 100_000, images: true, reasoning: true, rate: 1, free: false },
  { id: "raccoon-19b265", name: "Raccoon-Work-260817-A", context: 1_000_000, output: 100_000, images: false, reasoning: true, rate: 1, free: false },
  { id: "raccoon-405a1c", name: "Raccoon-Work-260817-B", context: 1_000_000, output: 100_000, images: false, reasoning: false, rate: 1, free: false },
  { id: "sn-sensenova-6-8-flash", name: "SenseNova-6.8-Flash", context: 256_000, output: 63_999, images: true, reasoning: true, rate: 0, rateWas: 0.5, free: true },
  { id: "sn-sensenova-6-8-flash-lite", name: "SenseNova-6.8-Flash-Lite", context: 256_000, output: 63_999, images: true, reasoning: true, rate: 0, rateWas: 0.5, free: true },
  { id: "sn-glm-5-3", name: "GLM-5-3", context: 1_000_000, output: 100_000, images: true, reasoning: true, rate: 0.75, free: false },
  { id: "sn-kimi-k3", name: "Kimi-K3", context: 1_000_000, output: 100_000, images: true, reasoning: true, rate: 1, free: false },
  { id: "sn-glm-5-3-flash", name: "GLM-5-3-Flash", context: 1_000_000, output: 100_000, images: false, reasoning: true, rate: 0.2, free: false },
  { id: "sn-deepseek-v4-1-flash", name: "DeepSeek-V4.1-Flash", context: 1_000_000, output: 100_000, images: false, reasoning: true, rate: 0.25, free: false },
  { id: "raccoon-chat-ml-5-5", name: "Raccoon Chat (默认)", context: 180_000, output: 80_000, images: false, reasoning: true, rate: 1, free: false },
]

// ---- JWT helpers ------------------------------------------------------------

function stripBearer(value) {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "").trim()
}

function decodeJwtClaims(token) {
  const raw = stripBearer(token)
  const parts = raw.split(".")
  if (parts.length < 2 || !parts[1]) return null
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8")
    const obj = JSON.parse(json)
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

function jwtExpiryMs(token) {
  const claims = decodeJwtClaims(token)
  const exp = Number(claims?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

function hexIdToDecimal(val) {
  const raw = String(val ?? "").trim().replace(/^0x/i, "")
  if (!raw || !/^[0-9a-fA-F]+$/.test(raw)) return ""
  try {
    return BigInt("0x" + raw).toString(10)
  } catch {
    return ""
  }
}

function extractUserId(claims) {
  if (!claims) return ""
  for (const k of ["sid", "iss"]) {
    const dec = hexIdToDecimal(claims[k])
    if (dec) return dec
  }
  for (const k of ["sub", "id", "user_id"]) {
    const s = String(claims[k] ?? "").trim()
    if (s) return s
  }
  return ""
}

function extractDisplayName(claims) {
  return String(claims?.name ?? "").trim()
}

// ---- the card's name --------------------------------------------------------

/**
 * A phone number as the cards show it: `86 13800138000` / `0086-…` / bare /
 * already masked → `138****8000`.
 */
function maskPhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "")
  if (digits.startsWith("0086") && digits.length - 4 >= 7) digits = digits.slice(4)
  else if (digits.startsWith("86") && digits.length - 2 >= 7) digits = digits.slice(2)
  // a phone is 11 digits; a shorter run is not a number to mask
  if (digits.length < 11) return ""
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

// One read per token, re-read after PHONE_TTL_MS; stale entries are dropped
// when the map passes PHONE_CAP, so it does not grow for the life of the host.
const PHONE_CAP = 2048
const phoneByToken = new Map()
const PHONE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The account's own phone number, read from the web API with the token the
 * sign-in already holds (`GET /api/web/auth/v1/user_info` answers `data.phone`,
 * measured `13800138000` on an `sms`-registered account).
 *
 * The JWT names the signer only by `Raccoon-pu-<uuid>` — an id, not a name —
 * so the card used to show that string. Best effort: no token, a refusal or an
 * answer without a number leaves the JWT's name on the card, and never costs a
 * sign-in.
 */
async function accountPhoneOf(access) {
  const token = stripBearer(access)
  if (!token) return ""
  const hit = phoneByToken.get(token)
  if (hit && Date.now() - hit.at < PHONE_TTL_MS) return hit.phone
  try {
    const res = await fetch(`${mainOrigin()}/api/web/auth/v1/user_info`, {
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return ""
    const payload = await res.json().catch(() => null)
    const phone = maskPhone(payload?.data?.phone)
    if (phone) {
      if (phoneByToken.size >= PHONE_CAP) {
        for (const [k, v] of phoneByToken) if (Date.now() - v.at >= PHONE_TTL_MS) phoneByToken.delete(k)
        if (phoneByToken.size >= PHONE_CAP * 2) phoneByToken.clear()
      }
      phoneByToken.set(token, { at: Date.now(), phone })
    }
    return phone
  } catch {
    return ""
  }
}

function vendorErrorText(payload, fallback) {
  for (const k of ["details", "message", "msg"]) {
    if (typeof payload?.[k] === "string" && payload[k].trim()) return payload[k].trim()
  }
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return payload.error.message.trim()
  }
  return fallback
}

// ---- Desktop auth.json (read-only) ------------------------------------------
//
// The desktop app has moved this file between releases. Builds that keep a
// client profile (1.1.x) put the box-agent home inside it and write
// <profile>/agent/config/auth.json, with the profile at
//   Windows: %USERPROFILE%\.office-raccoon (moved there from %APPDATA%)
//   macOS:   ~/Library/Application Support/office-raccoon
// (clientProfile.ts: openDefaultClientProfile, app.getPath("appData")).
// Older installs, and a profile the app still treats as legacy user data,
// keep ~/.box-agent/config/auth.json. Every layout is read, the profile ones
// first, so either build is picked up without an env override.

// The arguments are for tests: Bun reads homedir() once, at start.
function appDataDir(home, platform, env) {
  if (platform === "win32") return String(env.APPDATA ?? "").trim() || join(home, "AppData", "Roaming")
  if (platform === "darwin") return join(home, "Library", "Application Support")
  return String(env.XDG_CONFIG_HOME ?? "").trim() || join(home, ".config")
}

function desktopAuthCandidates(home = homedir(), platform = process.platform, env = process.env) {
  for (const envKey of ["RACCOON_BOX_AGENT_CONFIG_DIR", "BOX_AGENT_CONFIG_DIR"]) {
    const v = String(env[envKey] ?? "").trim()
    if (v) return [join(v, "auth.json")]
  }
  const profiles = [join(appDataDir(home, platform, env), "office-raccoon")]
  if (platform === "win32") profiles.unshift(join(home, ".office-raccoon"))
  return [
    ...profiles.map((p) => join(p, "agent", "config", "auth.json")),
    join(home, ".box-agent", "config", "auth.json"),
  ]
}

// The first candidate that is a file, else the first (which then reads as
// not signed in).
function desktopAuthPath(candidates = desktopAuthCandidates()) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return candidates[0]
}

function readDesktopAuth() {
  const p = desktopAuthPath()
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size <= 0 || st.size > 256 * 1024) return null
    const raw = JSON.parse(readFileSync(p, "utf8"))
    const access = stripBearer(raw?.access_token)
    if (!access) return null
    const claims = decodeJwtClaims(access)
    const uid = extractUserId(claims)
    const name = extractDisplayName(claims)
    const expires = jwtExpiryMs(access)
    return {
      access,
      refresh: "",
      expires,
      uid,
      name: name || (uid ? `Raccoon-${uid}` : PROVIDER_NAME),
      source: "desktop",
    }
  } catch {
    return null
  }
}

// ---- Token refresh (single-flight) ------------------------------------------

const renewing = new Map()
const renewed = new Map()

async function callRefreshApi(refreshToken, expectedUid = "") {
  const res = await fetch(`${authBase()}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let payload = {}
  try {
    payload = JSON.parse(text) ?? {}
  } catch {}
  if (!res.ok) {
    const msg = vendorErrorText(payload, `HTTP ${res.status}`)
    const err = new Error(`商汤小浣熊刷新 Token 失败: ${msg}`)
    if (res.status >= 400 && res.status < 500) err.signIn = "expired"
    throw err
  }
  const data = payload?.data ?? {}
  const access = stripBearer(data?.access_token)
  if (!access) {
    const msg = vendorErrorText(payload, "未返回新 Token")
    const err = new Error(`商汤小浣熊刷新 Token 失败: ${msg}`)
    err.signIn = "expired"
    throw err
  }
  const refresh = stripBearer(data?.refresh_token) || refreshToken
  const expires = jwtExpiryMs(access)
  const claims = decodeJwtClaims(access)
  const uid = extractUserId(claims)
  // A renewal answers for the account the refresh token names. When the token
  // it hands back belongs to someone else the stored credential is not the one
  // this seat signed in with — a refresh token that moved between accounts (the
  // desktop app signs in to one account at a time and rotates its own). Taking
  // it would bill the seat to another account and report that account's
  // credits, the failure plugins #166 was. The old credential stays exactly as
  // it is, the seat is not marked expired, and the next attempt can still
  // succeed if the vendor answers its own account again (rsfree
  // internal/upstream/client.go:580-615 refuses the same way).
  if (expectedUid && uid && String(uid) !== String(expectedUid)) {
    const err = new Error("商汤小浣熊续期返回了不同账号，旧凭证未被覆盖")
    err.signIn = "kept"
    throw err
  }
  const name = extractDisplayName(claims)
  return { access, refresh, expires, ...(uid ? { uid } : {}), ...(name ? { name } : {}) }
}

async function renewToken(a, save) {
  const key = a.refresh
  const done = renewed.get(key)
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) {
    const merged = { ...a, ...done.next }
    await save?.(merged)
    return merged
  }
  let r = renewing.get(key)
  if (!r) {
    r = (async () => {
      const next = await callRefreshApi(a.refresh, a.uid)
      renewed.set(key, { next, at: Date.now() })
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, r)
  }
  const next = await r
  const merged = { ...a, ...next }
  await save?.(merged)
  return merged
}

function isStale(a, marginMs = EARLY_MS) {
  const exp = Number(a?.expires) || jwtExpiryMs(a?.access)
  return exp > 0 && Date.now() >= exp - marginMs
}

// Desktop sign-in is strictly read-only: never write the app's auth.json
// and never spend the desktop app's refresh token. The app holds one account
// at a time, so a seat keeps the token it was signed in with, saved on its own
// record through the client (as kiro does), and reads the app only to take a
// newer token for that same account. The app's current account never stands in
// for a seat it does not name: a seat answered with another account's token
// was billed to the wrong account and reported that account's credits, with
// nothing anywhere saying so (plugins #166).
//
// sameAccount says whether a seat names the account the app holds now. A uid
// the read token does not carry never agrees: the seat's own token is used, or
// the seat asks to be signed in again, rather than being answered with
// credentials it cannot be shown to own. A seat that names no account at all
// has nothing to protect and means the app's own account.
function sameAccount(seat, read) {
  if (!read) return false
  if (seat?.uid) return !!read.uid && String(seat.uid) === String(read.uid)
  // accountId is the identity, as on main: the seat's own name is what the
  // app's read carries for the same account.
  if (seat?.accountId) return !!read.name && String(seat.accountId) === String(read.name)
  return true
}

async function currentAuth(client, auth, force = false) {
  if (auth?.source === "desktop") {
    const d = readDesktopAuth()
    // the app holds this seat's account: its token is the newest there is,
    // and a seat asked again after a refusal takes it
    if (sameAccount(auth, d) && !isStale(d, EARLY_MS)) {
      let next = { ...auth, ...d }
      if (d.access && d.access !== auth.access) {
        // A desktop seat stored by an earlier version is named `Raccoon-pu-…`:
        // when the app's token changes, read the phone and keep it on the
        // record (magpie replaces an account only at sign-in, merging fields
        // on renewal).
        const phone = await accountPhoneOf(d.access)
        if (phone) next = { ...next, phone, cardName: phone }
        try {
          await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: next })
        } catch {}
      }
      return { a: next, didRenew: false }
    }
    // the app holds another account, or none: this seat goes on with the
    // token it was signed in with until that token ends
    if (!force && auth.access && !isStale(auth, EARLY_MS)) return { a: { ...auth }, didRenew: false }
    if (sameAccount(auth, d)) {
      const err = new Error("商汤小浣熊桌面端登录态已过期，请打开商汤小浣熊客户端重新登录")
      err.signIn = "expired"
      throw err
    }
    const err = new Error(
      d ? "商汤小浣熊桌面端已切换为其他账号，请重新登录" : "商汤小浣熊桌面端未登录，请打开商汤小浣熊客户端登录",
    )
    err.signIn = "expired"
    throw err
  }

  let a = { ...auth }
  for (let i = 0; i < 8 && a.refresh; i++) {
    const d = renewed.get(a.refresh)
    if (!d || Date.now() - d.at >= KEEP_RENEWED_MS) break
    a = { ...a, ...d.next }
  }
  if (!a.expires && a.access) a.expires = jwtExpiryMs(a.access)
  const alreadyRenewed = a.access !== auth.access || a.refresh !== auth.refresh
  if ((alreadyRenewed || !force) && !isStale(a, EARLY_MS)) {
    if (alreadyRenewed) {
      try {
        await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: a })
      } catch {}
    }
    return { a, didRenew: alreadyRenewed }
  }
  if (!a.refresh) {
    if (!force && a.access && (!a.expires || Date.now() < a.expires)) return { a, didRenew: alreadyRenewed }
    const err = new Error("商汤小浣熊登录态已过期且无 refresh_token，请重新登录")
    err.signIn = "expired"
    throw err
  }
  const next = await renewToken(a, async (updated) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: updated })
    } catch {}
  })
  return { a: next, didRenew: true }
}

// ---- Models catalog ---------------------------------------------------------

let catalogCache = { origin: "", models: null, at: 0 }

function numOf(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function parseCatalog(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload
  const categories = Array.isArray(data?.categories) ? data.categories : []
  const seen = new Set()
  const out = []
  for (const cat of categories) {
    // the picker can only route a completion to a chat model; the catalog
    // mixes other categories in (modelmux PROTOCOL.md 5.2: take the
    // `type === 'chat'` one). A category with no type is kept.
    const kind = String(cat?.type ?? "").trim().toLowerCase()
    if (kind && kind !== "chat") continue
    for (const entry of Array.isArray(cat?.models) ? cat.models : []) {
      const id = String(entry?.name || entry?.model_name || "").trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      const codename = String(entry?.description ?? "").trim()
      const displayName = String(entry?.display_name ?? "").trim() || (codename && codename.length <= 64 ? codename : id)
      const tags = (Array.isArray(entry?.tags) ? entry.tags : []).map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean)
      const images = tags.some((t) => t === "vision" || t === "image" || t === "image-understanding")
      const context = Math.floor(numOf(entry?.context_window ?? entry?.contextWindow ?? entry?.params?.context_window ?? entry?.params?.contextWindow) || 200_000)
      const output = Math.floor(numOf(entry?.max_tokens ?? entry?.maxTokens ?? entry?.params?.max_tokens ?? entry?.params?.maxTokens) || 64_000)
      const baseRate = numOf(entry?.billing_multiplier)
      const effRate = numOf(entry?.billing_effective_multiplier)
      const rate = effRate ?? baseRate
      const free = rate === 0
      const rateWas = baseRate !== undefined && effRate !== undefined && effRate < baseRate ? baseRate : undefined
      out.push({
        id,
        name: displayName,
        context,
        output,
        images,
        reasoning: true,
        free,
        ...(rate !== undefined ? { rate } : {}),
        ...(rateWas !== undefined ? { rateWas } : {}),
      })
    }
  }
  if (!seen.has("raccoon-chat-ml-5-5")) {
    out.push({ id: "raccoon-chat-ml-5-5", name: "Raccoon Chat (默认)", context: 180_000, output: 80_000, images: false, reasoning: true, rate: 1, free: false })
  }
  return out
}

async function fetchLiveModels(token) {
  const base = llmBase()
  if (catalogCache.models && catalogCache.origin === base && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models
  }
  const headers = { Accept: "application/json" }
  if (token) headers.Authorization = "Bearer " + stripBearer(token)
  const res = await fetch(`${base}/model_catalog`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const payload = await res.json()
  const models = parseCatalog(payload)
  if (!models.length) throw new Error("empty catalog")
  catalogCache = { origin: base, models, at: Date.now() }
  return models
}

function configModels() {
  return Object.fromEntries(
    FALLBACK_MODELS.map((m) => [
      m.id,
      {
        name: m.name,
        limit: { context: m.context, output: m.output },
        tool_call: true,
        reasoning: !!m.reasoning,
        attachment: !!m.images,
        modalities: { input: m.images ? ["text", "image"] : ["text"], output: ["text"] },
        free: !!m.free,
        ...(m.rate !== undefined ? { rate: m.rate } : {}),
        ...(m.rateWas !== undefined ? { rateWas: m.rateWas } : {}),
      },
    ]),
  )
}

function runtimeModel(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: llmBase(), npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: !!m.reasoning,
      attachment: !!m.images,
      toolcall: true,
      input: { text: true, image: !!m.images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
    free: !!m.free,
    ...(m.rate !== undefined ? { rate: m.rate } : {}),
    ...(m.rateWas !== undefined ? { rateWas: m.rateWas } : {}),
  }
}

// ---- SSE model rewrite ------------------------------------------------------

function rewriteSseModel(res, requestedModel, signInHeader) {
  const headers = new Headers(res.headers)
  headers.set("X-Magpie-Sign-In", signInHeader)
  if (!requestedModel || !res.body) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  const ct = (headers.get("content-type") || "").toLowerCase()
  if (ct.includes("application/json")) {
    return (async () => {
      const text = await res.text()
      try {
        const obj = JSON.parse(text)
        if (obj && typeof obj === "object" && "model" in obj) {
          obj.model = requestedModel
          headers.delete("content-length")
          return new Response(JSON.stringify(obj), { status: res.status, statusText: res.statusText, headers })
        }
      } catch {}
      return new Response(text, { status: res.status, statusText: res.statusText, headers })
    })()
  }
  if (!ct.includes("text/event-stream")) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
  const dec = new TextDecoder()
  const enc = new TextEncoder()
  let buf = ""
  const rewriteLine = (line) => {
    if (!line.startsWith("data:")) return line
    const dataStr = line.slice(5).trim()
    if (!dataStr || dataStr === "[DONE]") return line
    try {
      const obj = JSON.parse(dataStr)
      if (obj && typeof obj === "object" && "model" in obj && obj.model !== requestedModel) {
        obj.model = requestedModel
        return "data: " + JSON.stringify(obj)
      }
    } catch {}
    return line
  }
  const stream = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buf += dec.decode(chunk, { stream: true })
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() ?? ""
        if (lines.length) {
          controller.enqueue(enc.encode(lines.map(rewriteLine).join("\n") + "\n"))
        }
      },
      flush(controller) {
        buf += dec.decode()
        if (buf) controller.enqueue(enc.encode(rewriteLine(buf.replace(/\r$/, ""))))
      },
    }),
  )
  headers.delete("content-length")
  return new Response(stream, { status: res.status, statusText: res.statusText, headers })
}

// ---- Usage, Check-in & Onboarding -------------------------------------------

async function apiGetJson(path, token, extraHeaders = {}, method = "GET") {
  const res = await fetch(`${mainOrigin()}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + stripBearer(token),
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let payload = {}
  try {
    payload = JSON.parse(text) ?? {}
  } catch {}
  if (res.status === 401) {
    const err = new Error(vendorErrorText(payload, "登录态已过期"))
    err.status = 401
    err.signIn = "expired"
    throw err
  }
  if (!res.ok) throw new Error(vendorErrorText(payload, `HTTP ${res.status}`))
  if (typeof payload?.code === "number" && payload.code !== 0) {
    const err = new Error(vendorErrorText(payload, `code=${payload.code}`))
    if (payload.code === 200001 || payload.code === 200003) {
      err.status = 401
      err.signIn = "expired"
    }
    throw err
  }
  return payload?.data ?? payload
}

function beijingTodayKey(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10)
}

async function claimDesktopOnboardingGrant(token) {
  try {
    const d = await apiGetJson("/api/web/desktop/v1/login/points/grant", token, desktopHeaders(), "POST")
    if (d?.granted === true) {
      const pts = Number(d?.popup?.points)
      return { points: Number.isFinite(pts) && pts > 0 ? Math.floor(pts) : 3000, settled: true }
    }
    if (d?.granted === false) {
      return { points: 0, settled: true }
    }
  } catch {}
  return { points: 0, settled: false }
}

// allBills is the account's whole bill history, newest first. The bills
// endpoint ignores paging.offset and always says total 0, so it can only be
// asked for the newest N rows; 200 covered under a day of an active account
// and left out the large grants a balance is made of (plugins #223).
async function allBills(token) {
  let bills = null
  for (const limit of [1000, 5000]) {
    bills = await apiGetJson(`/api/web/points/v1/bills?paging.limit=${limit}&paging.offset=0`, token)
    if (!Array.isArray(bills?.items) || bills.items.length < limit) break
  }
  return bills
}

// beijingMidnight is the next Beijing midnight, the boundary of the vendor's
// own day: the daily grants lapse at 23:59:59+08:00 on the day they were
// given (`expire_at` in the bills), so the pool holding them starts again
// there.
function beijingMidnight(nowMs = Date.now()) {
  const shifted = nowMs + 8 * 3600_000
  const dayStart = Math.floor(shifted / 86_400_000) * 86_400_000
  return new Date(dayStart + 86_400_000 - 8 * 3600_000).toISOString()
}

async function queryUsage(token) {
  const [points, entitlement, bills] = await Promise.all([
    apiGetJson("/api/web/points/v1/balance", token),
    apiGetJson("/api/web/auth/v1/entitlement_info", token).catch(() => null),
    allBills(token).catch(() => null),
  ])
  const avail = Math.floor(Number(points?.available_points) || 0)

  const office = entitlement?.office ?? entitlement?.code ?? {}
  const proEnable = office?.pro_enable === true || entitlement?.code?.pro_enable === true
  const planType = office?.active_plan?.type || office?.plan_type || ""
  const plan = proEnable ? (planType && planType !== "none" ? planType : "Pro") : "Free"
  const expireAt = office?.pro_expired_time || office?.active_plan?.subscription_expired_at || null

  // Sum only what the vendor actually reports as granted in unexpired bills.
  // If bills don't account for the current balance, report the balance with no window.
  // Two totals come out of it: every unexpired grant (the reading before the
  // split), and the ones that lapse. `expire_at` is what tells them apart —
  // `daily_grant` carries one, `reward_grant` does not — so the second is what
  // the day's own bucket was worth, and the reward is never counted into it.
  let grantedFromBills = 0
  let expiringGranted = 0
  let soonestExpMs = 0
  let expiringPts = 0
  const now = Date.now()
  for (const item of Array.isArray(bills?.items) ? bills.items : []) {
    const pts = Math.floor(Number(item?.points) || 0)
    if (pts <= 0) continue
    const expStr = typeof item?.expire_at === "string" ? item.expire_at : ""
    const expMs = expStr ? Date.parse(expStr) : 0
    if (expMs > 0 && expMs <= now) continue
    grantedFromBills += pts
    if (expMs > now) {
      expiringGranted += pts
      if (!soonestExpMs || expMs < soonestExpMs) {
        soonestExpMs = expMs
        expiringPts = pts
      } else if (expMs === soonestExpMs) {
        expiringPts += pts
      }
    }
  }
  const runsOutAt = soonestExpMs ? new Date(soonestExpMs).toISOString() : null

  const said = points?.available_points
  const told = said != null && said !== "" && Number.isFinite(Number(said))
  const saidDaily = points?.daily_points
  const dailyKnown = saidDaily != null && saidDaily !== "" && Number.isFinite(Number(saidDaily))
  const daily = dailyKnown ? Math.max(0, Math.floor(Number(saidDaily))) : null

  const head = {
    plan,
    ...(proEnable && expireAt ? { until: new Date(expireAt).toISOString() } : {}),
  }

  if (daily == null) {
    // The reply names no day's bucket, so there is nothing to split by and a
    // split would have to be guessed. Read it as before: one share over every
    // grant the bills account for, else the balance as a wallet.
    if (grantedFromBills > 0 && grantedFromBills >= avail) {
      const used = grantedFromBills - avail
      return {
        ...head,
        windows: [
          {
            name: "Credits",
            used: (100 * used) / grantedFromBills,
            display: `${used} / ${grantedFromBills}`,
            amount: used,
            limit: grantedFromBills,
            unit: "credits",
            ...(runsOutAt ? { runsOutAt, runsOut: Math.min(avail, expiringPts) } : {}),
          },
        ],
      }
    }
    // A balance the bills cannot account for tells no share, but it is still a
    // reading: a wallet window carries it, so routing knows the account and
    // sorts it by what it has left (#3950). A reply that names no number makes
    // no window: 0 is what a missing figure reads as, and one at 0 is a
    // spent-out account.
    return { ...head, balance: `${avail} credits`, windows: told ? [{ name: "Credits", balance: avail, unit: "credits" }] : [] }
  }

  // The vendor keeps two kinds of points apart, and separating them is the
  // point: `daily_points` is the day's grant (300 a check-in), worth nothing
  // after Beijing midnight; everything else — the onboarding reward, the
  // monthly and the top-up buckets — never lapses. Reported as two windows,
  // routing sends a request to an account whose day still holds something
  // before one whose day is gone, so the grants are spent rather than lost at
  // midnight.
  //
  // What is permanent is the rest of the total rather than the named buckets
  // summed, so one the vendor adds later is permanent by default instead of
  // vanishing; without a named total there is no figure to take it from, and
  // a missing one must not read as 0.
  const permanent = !told ? null : Math.max(0, avail - daily)

  // The day's limit is what its own grants were worth. An `expire_at` is what
  // tells them from the reward — `daily_grant` carries one, `reward_grant`
  // does not — so counting every grant would put the 9000 reward into the day
  // and read 9294 / 9600 used. A grant the vendor has written but the balance
  // has not moved for yet would likewise read below nothing, so the day's own
  // figure is the floor of its limit and the share is clamped to 0–100.
  const pairPresent = expiringGranted > 0
  const dayLimit = Math.max(daily, expiringGranted)
  const daySpent = pairPresent ? dayLimit - daily : 0
  const dayShare = pairPresent ? Math.max(0, Math.min(100, (100 * daySpent) / dayLimit)) : 0

  const windows = []
  if (pairPresent) {
    // A share to order the account by, renewing at the vendor's own day and
    // lapsing when its grants do. This is the window that decides who answers
    // while any of the pool's days is left, which is what drains the days.
    windows.push({
      name: "每日积分",
      used: dayShare,
      display: `${daySpent} / ${dayLimit}`,
      amount: daySpent,
      limit: dayLimit,
      unit: "credits",
      resetsAt: beijingMidnight(now),
      span: 86_400,
      ...(runsOutAt ? { runsOutAt, runsOut: Math.min(daily, expiringPts) } : {}),
    })
  } else if (daily > 0) {
    // No grant to give the day a limit — unreadable bills, or the day before
    // its first check-in. A made-up limit would always read as full, so the
    // balance is carried as itself; it still tells routing which account has
    // more of the day left, which is what drains the days.
    windows.push({ name: "每日积分", balance: daily, unit: "credits" })
  } else {
    // The day is spent and nothing says of what: a share at 100 is that, and
    // no `balance: 0` is carried — a lone one would drag the account's `Left`
    // to nothing beside the wallet below. A spent day with no wallet at all
    // still carries, because a lone `used: 100` is a known, used-up account
    // where an empty window list is an unknown one.
    windows.push({ name: "每日积分", used: 100, unit: "credits", resetsAt: beijingMidnight(now), span: 86_400 })
  }

  // The permanent wallet weighs only once the day is gone. A wallet has no
  // share and no renewal, so the one thing routing can order it by is the most
  // left (#3950, `byLeft`) — and permanent points differ per account, so
  // weighing them early parks the pool on whichever account holds the most
  // while the day's grant nobody spent lapses at midnight.
  //
  // Once the day is gone the wallet joins *without* the day's window stepping
  // aside, and the share stays at 100: that files the account in the used-up
  // tier (`tier`, `routes/strategies.go`), behind every account whose day
  // still has something in it, whatever its wallet holds — and `Allowance.For`
  // takes the max share while `Allowance.Left` takes the min balance, each
  // window on its own, so under `usage` the balance breaks the tie inside that
  // tier. Stepping the day aside instead would read as an account with no
  // share at all, which `usage` ranks *ahead* of a day nearly gone.
  //
  // A day's last point is the mark, not magpie's 98%: those two points still
  // pay, so the account holding them still goes ahead of one whose day is
  // gone. An empty wallet is no window at all — a lone `balance: 0` reads as
  // used up, which would bench an account its day still pays for (loomy's
  // rule, `loomy/daily-grant-carries`).
  const wallet = permanent != null && permanent > 0 ? { name: "永久积分", balance: permanent, unit: "credits" } : null
  if (wallet) {
    if (daily > 0) wallet.aside = true
    windows.push(wallet)
  }

  return { ...head, windows }
}

function billKey(item) {
  return String(item?.bill_id || item?.biz_id || `${item?.created_at ?? ""}:${item?.points ?? 0}:${item?.event_name ?? ""}`)
}

function isCheckinGrantBill(item, today) {
  const pts = Math.floor(Number(item?.points) || 0)
  if (pts <= 0) return false
  const createdAt = String(item?.created_at ?? "")
  if (createdAt.slice(0, 10) !== today) return false
  const biz = String(item?.biz_type ?? "")
  return !biz || biz === "daily_grant" || biz === "reward_grant"
}

// The `setting_info` answer carries the vendor's own "you were just granted
// this" flags. They are the only same-second evidence there is: the credits
// endpoint that lists bills is written behind the grant, so an answer read
// right after the trigger can be one to three minutes stale and show nothing
// (rsfree's comment on the reconciliation page: 「流水本身滞后 1~3 分钟」).
// Buddy reads the same two flags and treats them as the grant having fired
// (providers/xiaohuanxiong/quota.py:181-214: the check-in is the GET of this
// endpoint and the flags are its answer). Either field may hold the points.
// Not an `export`: magpie's host takes every exported function as a plugin
// factory (scripts/check.mjs:36-60), so this one stays reachable through
// `_internal` only.
function popupGrantPoints(payload) {
  for (const key of ["point_grant_popups", "point_grant_toast"]) {
    const node = payload?.[key]
    const pts = Math.floor(Number(node?.points))
    if (Number.isFinite(pts) && pts > 0) return pts
  }
  return 0
}

// The popup is a reading of "a grant fired", not a ledger entry: the same
// answer carries it again on every call that day. Handing it to the card once
// per account per Beijing day keeps both directions honest — the day the bills
// lag is not reported as "done", and the second call that day does not count
// the same grant again. Memory, like desktopOnboardingSettled: a restart can
// report one grant twice, which is the cheaper error than reporting a paid day
// as unpaid.
const popupGrantReported = new Set()

function popupCreditable(points, accountKey, today) {
  const pts = Math.floor(Number(points) || 0)
  if (pts <= 0) return 0
  const key = `${today}|${accountKey ?? ""}`
  if (popupGrantReported.has(key)) return 0
  popupGrantReported.add(key)
  return pts
}

const desktopOnboardingSettled = new Set()

// One check-in per account at a time. The host can deliver what a user did
// once more than once — magpie re-sends a request after a body-cap refit
// (internal/gateway/body_cap.go:159), a token-field retry
// (internal/gateway/token_field.go:45) and any 404, which it counts as
// retryable (internal/gateway/fallback.go:1766) — and its check-in loop plus a
// user pressing the button can overlap. Two runs of the same account's
// check-in would each read the before-snapshot, each claim the onboarding grant
// and each report the grant as new, so the card would count one grant twice.
// The second run waits for the first and then reads its result instead of
// repeating it.
const checkinInFlight = new Map()

async function serializeCheckin(a, run) {
  const key = a?.uid || a?.accountId || a?.access || ""
  const busy = checkinInFlight.get(key)
  if (busy) return busy
  const p = (async () => run())().finally(() => checkinInFlight.delete(key))
  checkinInFlight.set(key, p)
  return p
}

async function performCheckIn(a, save) {
  const token = a.access
  const today = beijingTodayKey()

  // Snapshot today's grant bills before triggering setting_info so a second
  // check-in on the same day reports "done" rather than "claimed" again.
  let beforeKeys = null
  try {
    const before = await apiGetJson("/api/web/points/v1/bills?paging.limit=20&paging.offset=0", token)
    const items = Array.isArray(before?.items) ? before.items : []
    beforeKeys = new Set(items.filter((x) => isCheckinGrantBill(x, today)).map(billKey))
  } catch {}

  const setting = await apiGetJson("/api/web/office/v3/setting_info", token, {
    ...desktopHeaders(),
    "X-Raccoon-Language": "zh",
  })
  const popupPts = popupGrantPoints(setting)

  let onboardingPts = 0
  const accountKey = a?.uid || a?.accountId || a?.access
  const alreadySettled = a?.onboardingSettled || (a?.source === "desktop" && desktopOnboardingSettled.has(accountKey))
  if (!alreadySettled) {
    const grant = await claimDesktopOnboardingGrant(token)
    onboardingPts = grant.points
    if (grant.settled) {
      if (a?.source === "desktop") {
        desktopOnboardingSettled.add(accountKey)
      } else if (save) {
        await save({ ...a, onboardingSettled: true }).catch(() => {})
      }
    }
  }

  // If the before-snapshot of bills could not be read, avoid false positives
  // from historical bills or repeating popup grants, while still reporting an
  // onboarding grant that this call just claimed. The snapshot is the only
  // thing that tells a fresh popup from one left in the answer since an earlier
  // call; without it, only the grant this call just claimed is reported.
  if (!beforeKeys) {
    if (onboardingPts > 0) {
      return {
        outcome: "claimed",
        credit: onboardingPts,
        message: `桌面端首次登录奖励 +${onboardingPts}`,
      }
    }
    return {
      outcome: "done",
      message: "今日已签到",
    }
  }

  // Read the bills again, and once more if nothing new is there yet: this is
  // the recheck the panel does after claiming (rsfree
  // internal/scheduler/scheduler.go:586 — a code 0 from the grant endpoint does
  // not mean the grant landed, so the status is read again). The window
  // between the two reads is one round trip plus the onboarding-grant call
  // above, which is enough for a grant that landed during those calls to show
  // up; the credits list is written behind the grant, so a single immediate
  // read reported "今日已签到" on a day that was actually paid.
  let newlyGranted = 0
  let hasNewRewardBill = false
  const names = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const bills = await apiGetJson("/api/web/points/v1/bills?paging.limit=20&paging.offset=0", token)
    const items = Array.isArray(bills?.items) ? bills.items : []
    items.forEach((item) => {
      if (!isCheckinGrantBill(item, today)) return
      if (beforeKeys.has(billKey(item))) return
      const pts = Math.floor(Number(item?.points) || 0)
      newlyGranted += pts
      if (String(item?.biz_type ?? "") === "reward_grant") hasNewRewardBill = true
      const ev = String(item?.event_name || "积分发放")
      if (!names.includes(ev)) names.push(ev)
    })
    if (newlyGranted > 0) break
  }

  // Sum daily check-in bills and the one-time onboarding grant when both land
  // in one call, unless the onboarding grant is already present as a new
  // reward_grant bill in /points/v1/bills (which would double-count it).
  if (onboardingPts > 0 && !hasNewRewardBill) {
    newlyGranted += onboardingPts
    if (!names.includes("桌面端首次登录奖励")) names.push("桌面端首次登录奖励")
  }

  if (newlyGranted <= 0 && onboardingPts <= 0) {
    // The bills read is the one that lags; the vendor's own answer said a
    // grant fired. Reporting "done" here is the quiet lie this replaces — but
    // only the first time that day, or a popup that stays in the answer would
    // be counted on every call.
    const credit = popupCreditable(popupPts, accountKey, today)
    if (credit > 0) {
      newlyGranted = credit
      names.push("今日签到")
    }
  }

  const totalCredit = newlyGranted
  if (totalCredit > 0) {
    return {
      outcome: "claimed",
      credit: totalCredit,
      message: `${names.join(" + ") || "今日积分"} +${totalCredit}`,
    }
  }
  return {
    outcome: "done",
    message: "今日已签到",
  }
}

// ---- Sign-in flows ----------------------------------------------------------

function buildAuthorizeUrl(state) {
  const u = new URL("/code/authorize", mainOrigin())
  u.searchParams.set("login_source", "desktop")
  u.searchParams.set("appname", "办公小浣熊客户端")
  u.searchParams.set("state", state)
  return u.toString()
}

function parseCallbackInput(raw, expectedState) {
  const text = String(raw ?? "").trim()
  if (!text) throw new Error("请输入回调链接或 Token")
  if (text.startsWith("{")) {
    const obj = JSON.parse(text)
    const access = stripBearer(obj?.access_token ?? obj?.accessToken)
    const refresh = stripBearer(obj?.refresh_token ?? obj?.refreshToken)
    if (!access) throw new Error("JSON 中缺少 access_token")
    return { direct: { access, refresh } }
  }
  if (text.split(".").length === 3 && !text.includes("://")) {
    return { direct: { access: stripBearer(text), refresh: "" } }
  }
  let u
  try {
    u = new URL(text)
  } catch {
    throw new Error("无效的回调链接或 Token 格式")
  }
  const code = (u.searchParams.get("code") || "").trim()
  const state = (u.searchParams.get("state") || "").trim()
  if (!code) throw new Error("回调链接中缺少授权码 code")
  if (expectedState && state && state !== expectedState) {
    throw new Error("回调链接 state 不匹配，请使用本次打开页面产生的回调链接")
  }
  return { code }
}

async function exchangeAuthCode(code) {
  const res = await fetch(`${authBase()}/login_with_authorization_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ authorization_code: code }),
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await res.json().catch(() => ({}))
  if (payload?.code === 200035) {
    throw new Error("授权码已失效，请重新发起网页登录")
  }
  const data = payload?.data ?? {}
  const access = stripBearer(data?.access_token)
  const refresh = stripBearer(data?.refresh_token)
  if (!res.ok || !access || !refresh) {
    throw new Error(vendorErrorText(payload, `换取凭证失败 (HTTP ${res.status})`))
  }
  return { access, refresh }
}

async function toSuccessAuth(access, refresh, extra = {}) {
  const claims = decodeJwtClaims(access)
  const uid = extractUserId(claims)
  const name = extractDisplayName(claims)
  const expires = jwtExpiryMs(access)
  const phone = await accountPhoneOf(access)
  return {
    type: "success",
    access,
    refresh: refresh || "",
    expires,
    // accountId is the account's identity in magpie (its user-set name, proxy,
    // model picks and a gateway key's list hang off it), so it stays what main
    // computes; the phone is a separate field (`phone`, `cardName`) that usage
    // shows as the card's name.
    accountId: name || (uid ? `Raccoon-${uid}` : PROVIDER_NAME),
    ...(phone ? { phone, cardName: phone } : {}),
    uid: uid || "",
    ...(name ? { name } : {}),
    ...extra,
  }
}

async function browserSignIn(timeoutMs = 10 * 60 * 1000) {
  // The current authorize page accepts desktop loopback callbacks only with
  // a 64-character hex state and a 127.0.0.1 /auth/callback URL.
  const state = randomBytes(32).toString("hex")
  const url = new URL(buildAuthorizeUrl(state))
  url.searchParams.set("desktop_callback", "loopback")
  let complete, timer, origin, received = false, settled = false
  const done = new Promise((resolve) => { complete = resolve })
  const finish = (result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    complete(result)
    server.close()
    server.closeIdleConnections?.()
  }
  const server = createServer(async (req, res) => {
    const reply = (status, text) => {
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'",
      })
      res.end(text)
    }
    const url = new URL(req.url || "/", "http://127.0.0.1")
    if (req.headers.host !== origin || url.pathname !== "/auth/callback") return reply(404, "Not found")
    if (req.method !== "GET") return reply(405, "Method not allowed")
    const q = url.searchParams
    if (q.getAll("state").length !== 1 || q.get("state") !== state) return reply(400, "回调不属于本次登录，请回到原授权页重试。")
    if (settled || received) return reply(409, "本次回调已经处理，请回到 Magpie 查看结果。")
    if (q.get("error")) {
      reply(400, "登录未获授权，请回到 Magpie 重新登录。")
      finish({ type: "failed", error: "商汤小浣熊授权被拒绝，请重新登录" })
      return
    }
    const code = q.get("code") || ""
    if (q.getAll("code").length !== 1 || !code || code.length > 4096) return reply(400, "回调缺少有效授权码，请回到原授权页重试。")
    received = true
    try {
      const tokens = await exchangeAuthCode(code)
      if (settled) return reply(408, "登录已超时，请回到 Magpie 重新登录。")
      reply(200, "商汤小浣熊登录成功，可以关闭此页并返回 Magpie。")
      finish(await toSuccessAuth(tokens.access, tokens.refresh))
    } catch (e) {
      reply(502, "登录未完成，请返回 Magpie 查看错误并重新登录。")
      finish({ type: "failed", error: e?.message ?? String(e) })
    }
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  origin = `127.0.0.1:${server.address().port}`
  url.searchParams.set("redirect", `http://${origin}/auth/callback`)
  timer = setTimeout(() => finish({ type: "failed", error: "商汤小浣熊登录超时，请重新登录" }), timeoutMs)
  timer.unref?.()
  return {
    url: url.toString(),
    instructions: "在浏览器完成商汤小浣熊登录并确认授权后，会自动返回此处；无需填写短信验证码或复制网页地址。",
    method: "auto",
    async callback() { return await done },
  }
}

function manualSignIn() {
  const state = randomUUID()
  const url = buildAuthorizeUrl(state)
  return {
    url,
    instructions:
      "在浏览器完成商汤小浣熊登录后，复制地址栏或弹窗跳转的 office-raccoon://auth/callback?code=... 链接粘贴到下方（也支持直接粘贴 JWT access_token）：",
    method: "code",
    async callback(input) {
      try {
        const parsed = parseCallbackInput(input, state)
        const tokens = parsed.direct ? parsed.direct : await exchangeAuthCode(parsed.code)
        return await toSuccessAuth(tokens.access, tokens.refresh)
      } catch (e) {
        return { type: "failed", error: e?.message ?? String(e) }
      }
    },
  }
}

function desktopSignIn() {
  return {
    url: "",
    instructions: "直接复用本机商汤小浣熊客户端的实时登录态（只读，不写入桌面端文件）。",
    method: "auto",
    async callback() {
      // A new seat takes the account the app holds now, and its token, and
      // keeps them on its own record: the app is signed in to one account at
      // a time and drops the previous one's token as soon as it rotates off
      // disk. Only the app's own account is offered here, so a seat is never
      // quietly handed some other account's credentials.
      const d = readDesktopAuth()
      if (!d) {
        return {
          type: "failed",
          error: `未检测到本机商汤小浣熊登录态（已查找 ${desktopAuthCandidates().join("、")}）`,
        }
      }
      if (isStale(d, EARLY_MS)) {
        return { type: "failed", error: "商汤小浣熊桌面端登录态已过期，请先打开商汤小浣熊客户端重新登录" }
      }
      // the app's own token reads the phone too, so a seat added here is named
      // like one signed in through the browser
      const phone = await accountPhoneOf(d.access)
      return {
        type: "success",
        access: d.access,
        refresh: "",
        expires: d.expires,
        source: "desktop",
        accountId: d.name || PROVIDER_NAME,
        ...(phone ? { phone, cardName: phone } : {}),
        uid: d.uid || "",
      }
    },
  }
}

// ---- Plugin export ----------------------------------------------------------

const raccoonBase = async ({ client }) => {
  const saveAuth = async (next) => {
    try {
      await client?.auth?.set?.({ path: { id: PROVIDER_ID }, body: next })
    } catch {}
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: NPM,
        api: llmBase(),
        ...was,
        models: { ...configModels(), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        try {
          let token = ""
          if (auth?.type === "oauth" && (auth.access || auth.source === "desktop")) {
            const { a } = await currentAuth(client, auth)
            token = a.access
          }
          const ms = await fetchLiveModels(token)
          if (!ms.length) return provider.models
          return Object.fromEntries(ms.map((m) => [m.id, runtimeModel(provider, m)]))
        } catch {
          return provider.models
        }
      },
    },
    auth: {
      provider: PROVIDER_ID,
      refreshLead: LEAD_MS,
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.access || auth.source === "desktop") return undefined
        if (!auth.refresh) return undefined
        const { a, didRenew } = await currentAuth(client, auth, true)
        if (!didRenew) return undefined
        // An account stored by an older version was named by `Raccoon-pu-…`;
        // its renewal is where the phone can still be read and put on the card.
        const phone = await accountPhoneOf(a.access)
        return {
          access: a.access,
          refresh: a.refresh,
          expires: a.expires,
          ...(a.uid ? { uid: a.uid } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(phone ? { phone, cardName: phone } : {}),
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}
        return {
          baseURL: llmBase(),
          apiKey: "raccoon",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            let bodyText = init?.body
            if (bodyText === undefined && req) bodyText = await req.clone().text()
            let requestedModel = ""
            try {
              const parsed = typeof bodyText === "string" ? JSON.parse(bodyText) : null
              if (typeof parsed?.model === "string") requestedModel = parsed.model
            } catch {}

            let a
            let didRenew = false
            try {
              ;({ a, didRenew } = await currentAuth(client, await getAuth()))
            } catch (e) {
              const expired = e?.signIn === "expired"
              return new Response(
                JSON.stringify({
                  error: {
                    message: e?.message ?? String(e),
                    type: expired ? "authentication_error" : "api_error",
                  },
                }),
                {
                  status: expired ? 401 : 502,
                  headers: {
                    "Content-Type": "application/json",
                    "X-Magpie-Sign-In": expired ? "expired" : "kept",
                  },
                },
              )
            }
            const sendOnce = (cred) => {
              const headers = new Headers(init?.headers ?? req?.headers)
              headers.delete("x-api-key")
              headers.delete("content-length")
              headers.set("Authorization", "Bearer " + cred.access)
              headers.set("Content-Type", "application/json")
              headers.set("Accept", "*/*")
              const ua = userAgent()
              if (ua) headers.set("User-Agent", ua)
              return fetch(req ? req.url : input, {
                ...init,
                method: init?.method ?? req?.method ?? "POST",
                headers,
                body: bodyText,
              })
            }

            let res = await sendOnce(a)
            if (res.status === 401 && a.refresh && a.source !== "desktop") {
              try {
                const retryAuth = await currentAuth(client, a, true)
                a = retryAuth.a
                didRenew = true
                res = await sendOnce(a)
              } catch {}
            }
            const signInState = res.status === 401 ? "expired" : didRenew && res.ok ? "renewed" : "kept"
            return rewriteSseModel(res, requestedModel, signInState)
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source === "desktop")) {
          return { error: "not signed in", signIn: "kept" }
        }
        try {
          let { a, didRenew } = await currentAuth(client, auth)
          let result
          try {
            result = await queryUsage(a.access)
          } catch (e) {
            if (e?.status === 401 && a.refresh && a.source !== "desktop") {
              const retryAuth = await currentAuth(client, a, true)
              a = retryAuth.a
              didRenew = true
              result = await queryUsage(a.access)
            } else {
              throw e
            }
          }
          return {
            ...result,
            // The card's name: the phone when the record has one, else what
            // the account is called (an older record has no phone).
            user: a.cardName || a.accountId || a.name || a.uid,
            signIn: didRenew ? "renewed" : "kept",
          }
        } catch (e) {
          return {
            error: e?.message ?? String(e),
            signIn: e?.signIn === "expired" ? "expired" : "kept",
          }
        }
      },
      async checkin(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth" || !(auth.access || auth.source === "desktop")) {
          return { outcome: "failed", message: "not signed in" }
        }
        try {
          let { a } = await currentAuth(client, auth)
          // serializeCheckin: the host may ask for the same account's check-in
          // twice at once (its own loop and the button, or a retried request);
          // the second call gets the first one's answer rather than a second
          // claim and a second "new" bill.
          return await serializeCheckin(a, async () => {
            try {
              return await performCheckIn(a, saveAuth)
            } catch (e) {
              if (e?.status === 401 && a.refresh && a.source !== "desktop") {
                ;({ a } = await currentAuth(client, a, true))
                return await performCheckIn(a, saveAuth)
              }
              throw e
            }
          })
        } catch (e) {
          return { outcome: "failed", message: e?.message ?? String(e) }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "商汤小浣熊账号 (浏览器登录 / 自动返回)",
          authorize: async () => browserSignIn(),
        },
        {
          type: "oauth",
          label: "商汤小浣熊桌面端登录态（读取本机客户端）",
          authorize: async () => desktopSignIn(),
        },
        {
          type: "oauth",
          label: "手动粘贴回调链接或 Token（非短信验证码）",
          authorize: async () => manualSignIn(),
        },
      ],
    },
  }
}

// extras: everything above is upstream's, unchanged. The wrapper adds the
// phone-side grant, the check-in triage, the vision whitelist, extra_body
// .thinking, the max_tokens floor and the refresh_conflict heal; see
// extras.mjs for the measurements behind each one.
export const RaccoonAuthPlugin = async (args = {}) => {
  const plugin = await raccoonBase(args)
  return extendRaccoon(plugin, {
    apiGetJson,
    readDesktop: readDesktopAuth,
    refreshOnce: (token) => callRefreshApi(token),
    saveAuth: async (body) => {
      try {
        await args?.client?.auth?.set?.({ path: { id: PROVIDER_ID }, body })
      } catch {}
    },
  })
}

export const _internal = {
  browserSignIn,
  desktopAuthPath,
  desktopAuthCandidates,
  sameAccount,
  stripBearer,
  decodeJwtClaims,
  jwtExpiryMs,
  hexIdToDecimal,
  extractUserId,
  extractDisplayName,
  parseCatalog,
  parseCallbackInput,
  rewriteSseModel,
  beijingTodayKey,
  billKey,
  popupGrantPoints,
  popupGrantReported,
  checkinInFlight,
  renewToken,
  desktopPlatform,
  desktopOnboardingSettled,
  USER_AGENT,
  userAgent,
  renewed,
  renewing,
}
