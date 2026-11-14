// Extras for the Loomy provider: the pieces index.mjs does not carry yet.
//
// Kept in its own file (like renew.mjs) so that a merge of upstream's
// index.mjs only has to keep a handful of marked call sites, not this code.
// Nothing here is called unless index.mjs calls it.
//
// What lives here:
//   - the eight onboarding tasks (one-time 10000 points, never claimed before)
//   - the traceparent / loomy-version headers (chat)

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { traceparent } from "./headers.mjs"

const OK = "000000"
const AUTH_CODES = new Set(["020002", "100002"])
const REQUEST_TIMEOUT = 20_000

// The client announces this version; the gateway has only ever been seen to
// check that the header is present (loomy2api constants.py). Measured against
// the 0.9.39 client's own traffic, which is the version the shapes here were
// rebuilt from.
export const LOOMY_VERSION = "0.9.39"

// ── the request-shape switch ───────────────────────────────────────────────
//
// Everything this fork does to a chat's headers and body on its way out — the
// client's attribution headers, traceparent, loomy-version, the UA, Accept and
// the plain application/json, and the session as Bearer alone — rides on one
// magpie switch, off by default: off sends what upstream sends, on sends what
// Loomy's own 0.9.39 client sends. The same shape as workbuddy's
// request_format_2108 and raccoon's request_shape_desktop_1_1_5, so a user
// meets one kind of switch in all three.
//
// What does NOT ride on it: the password sign-in and its renewal (renew.mjs),
// the onboarding ledger. Those are the account's life, not the request's
// shape, and turning them off would cost the user the sign-in rather than
// send a different client.
//
// OpenCode has no switches, so there the request keeps the client's shape —
// the same thing this switch asks for. `input.magpie` is absent there, and
// `option` is absent with it.
export const WIRE_SWITCH = "request_shape_client_0_9_39"
// the switch a chat's shape is read from, newest first: the newest one on
// sends, since magpie hands a plugin nothing when a switch changes (host.js's
// setProviderOptions only takes the values over). A second shape to add later
// is one more entry here.
export const WIRE_SWITCHES = [{ key: WIRE_SWITCH }]
export const wireOn = (magpie) => WIRE_SWITCHES.some((f) => magpie?.option?.("loomy", f.key) === true)

// shapeOf is the answer for a host that may have no switches at all. magpie
// passes input.magpie and reads the switch; OpenCode passes nothing, and
// there the request keeps the client's shape — the fork's whole point, and
// what the switch asks for anyway. So "no magpie" is not "off".
export const shapeOf = (magpie) => (magpie === undefined ? true : wireOn(magpie))

// the switch as the provider's editor draws it
export const WIRE_OPTION = {
  key: WIRE_SWITCH,
  label: "Send as the Loomy client 0.9.39",
  description:
    "Sends a chat the way Loomy's own 0.9.39 client does — its attribution headers, traceparent and loomy-version, its User-Agent and Accept — instead of the way upstream's plugin sends it. Off sends upstream's request. Both sign in as the same account; what differs is the client the gateway reads.",
  labels: { zh: "按 Loomy 客户端 0.9.39 发送", "zh-TW": "以 Loomy 用戶端 0.9.39 送出", ja: "Loomy クライアント 0.9.39 として送信", de: "Als Loomy-Client 0.9.39 senden" },
  descriptions: {
    zh: "按 Loomy 自己 0.9.39 客户端的请求形状发送 — 它的归因头、traceparent 与 loomy-version、User-Agent 与 Accept，以及只用 Bearer 传 session — 而不是上游插件的形状。关闭时按上游的形状发送。两者登录同一个账号，区别只在网关据此识别的客户端。",
    "zh-TW": "以 Loomy 自己 0.9.39 用戶端的請求形狀送出 — 它的歸因標頭、traceparent 與 loomy-version、User-Agent 與 Accept，以及只用 Bearer 傳 session — 而不是上游外掛的形狀。關閉時以上游的形狀送出。兩者登入同一個帳號，差別只在閘道據此識別的用戶端。",
    ja: "Loomy 自身の 0.9.39 クライアントのリクエスト形式 — 帰属ヘッダー、traceparent と loomy-version、User-Agent と Accept、セッションを Bearer のみで送る — で送信します（上流プラグインの形式ではありません）。オフのときは上流の形式で送信します。どちらも同じアカウントで、違いはゲートウェイがどのクライアントと見るかだけです。",
    de: "Sendet einen Chat im Format des Loomy-Clients 0.9.39 — Zuordnungs-Header, traceparent, loomy-version, User-Agent und Accept — statt im Format des Upstream-Plugins. Aus sendet die Upstream-Anfrage. Beide nutzen dasselbe Konto; anders ist nur, als welcher Client das Gateway die Anfrage liest.",
  },
}

const env = (name, fallback) => {
  const v = process.env[name]?.trim()
  return v ? v.replace(/\/+$/, "") : fallback
}
const integrationBase = () => env("LOOMY_POINTS_BASE_URL", "https://loomyad.xunfei.cn")
const gateway = (path) => `${integrationBase()}${path}`

// ── the onboarding tasks ───────────────────────────────────────────────────
//
// Loomy's client decides "completed" locally and reports only the key; the
// gateway takes the key at face value and pays the points. Measured twice
// against production (agent2api loomy/onboarding.rs 2026-10-08, modelmux
// PROTOCOL.md 2026-09-26): eight POSTs on a fresh account took the balance
// from 0 to 10000 without a single real action, and a repeat POST answers
// alreadyCompleted=true without paying again.
export const ONBOARDING_TASKS = [
  { key: "share_soul", points: 2000, label: "分享你的 Soul" },
  { key: "generate_ppt", points: 1500, label: "生成一份 PPT" },
  { key: "install_skill", points: 1500, label: "安装一个技能" },
  { key: "create_soul", points: 1500, label: "创建一个 Soul" },
  { key: "pick_skill", points: 1000, label: "挑选一个技能" },
  { key: "set_schedule", points: 1000, label: "设置一个日程" },
  { key: "configure_remote", points: 1000, label: "配置远程设备" },
  { key: "first_message", points: 500, label: "发出第一条消息" },
]
export const ONBOARDING_TOTAL = ONBOARDING_TASKS.reduce((n, t) => n + t.points, 0)

// ── small HTTP helper ──────────────────────────────────────────────────────

class Expired extends Error {
  constructor(message) {
    super(message)
    this.signIn = "expired"
  }
}

async function apiJson(path, session, { method = "GET", body, headers = {} } = {}) {
  if (!session) throw new Expired("Loomy 账号缺少 session")
  const init = {
    method,
    // `token` only. The client's onboarding calls carry no Authorization, so
    // neither does this; and its Accept on these is the runtime default
    // (`*/*`), not an explicit application/json.
    headers: { Accept: "*/*", token: session, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body)
  }
  const res = await fetch(gateway(path), init)
  if (res.status === 401 || res.status === 403) throw new Expired("Loomy 登录态已失效，请重新登录")
  const payload = await res.json().catch(() => null)
  if (!payload) throw new Error(`Loomy 接口返回了无法解析的内容（HTTP ${res.status}）`)
  const code = String(payload.code ?? "")
  if (AUTH_CODES.has(code)) throw new Expired("Loomy 登录态已失效，请重新登录")
  if (!res.ok) throw new Error(`Loomy 接口返回 HTTP ${res.status}`)
  return payload
}

// ── the onboarding ledger ──────────────────────────────────────────────────
//
// A settled key is never asked about again, so a finished account costs zero
// requests per day. That is the point upstream makes about not putting a
// one-time gift into the daily loop: the loop would keep paying for a query
// that can no longer answer anything new.

export function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  if (xdg) return join(xdg, "magpie")
  return join(homedir(), ".config", "magpie")
}

export function ledgerFile() {
  const custom = process.env.LOOMY_ONBOARDING_LEDGER?.trim()
  return custom || join(configDir(), "loomy-onboarding.json")
}

export function accountKeyOf(a) {
  const named = a?.uid ?? a?.userId ?? a?.accountId
  if (named) return String(named)
  const session = String(a?.access ?? "")
  return session ? `session:${session.slice(0, 12)}` : "default"
}

export function readLedger(file = ledgerFile()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function writeLedger(state, file = ledgerFile()) {
  try {
    mkdirSync(join(file, ".."), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

// ── claiming ───────────────────────────────────────────────────────────────

// Claims whatever is not settled yet. Serial on purpose: the gateway is the
// same one a chat is billed through, and eight parallel grants are a pattern
// no client ever produces. Any auth code stops the loop rather than hammering
// the remaining keys with a dead session.
export async function claimOnboarding(session, a, opts = {}) {
  const file = opts.file ?? ledgerFile()
  const key = accountKeyOf(a)
  const state = readLedger(file)
  const settled = new Set(Array.isArray(state[key]) ? state[key] : [])
  if (settled.size >= ONBOARDING_TASKS.length) return { points: 0, keys: [], settled: true, skipped: "already-settled" }

  const claimed = []
  let points = 0
  let expired = false
  for (const task of ONBOARDING_TASKS) {
    if (settled.has(task.key)) continue
    let payload
    try {
      payload = await apiJson("/api/v1/onboarding/tasks/complete", session, { method: "POST", body: { key: task.key } })
    } catch (e) {
      if (e?.signIn === "expired" || e instanceof Expired) {
        expired = true
        break
      }
      // one key failing says nothing about the next one; keep going
      continue
    }
    const code = String(payload.code ?? "")
    if (AUTH_CODES.has(code)) {
      expired = true
      break
    }
    if (code !== OK) continue
    const already = payload?.data?.alreadyCompleted === true
    // Settled either way: a key the server calls already-completed will never
    // pay, and asking again every day is exactly the wasted query upstream
    // warns about. Only a first-time completion is money.
    settled.add(task.key)
    if (!already) {
      claimed.push(task.key)
      points += task.points
    }
  }
  if (claimed.length || settled.size !== new Set(Array.isArray(state[key]) ? state[key] : []).size) {
    state[key] = [...settled]
    writeLedger(state, file)
  }
  return { points, keys: claimed, settled: settled.size >= ONBOARDING_TASKS.length, expired }
}

// ── tracing headers ────────────────────────────────────────────────────────
//
// Five independent implementations send these on every gateway call; one
// (modelmux, 2026-10-19) reports the calls worked without them. They are
// cheap and idempotent, so they go out; whether the gateway needs them stays
// an open A/B question rather than a claim either way.
export function traceHeaders() {
  return { traceparent: traceparent(), "loomy-version": LOOMY_VERSION }
}

// ── the plugin wrapper ─────────────────────────────────────────────────────

// Wraps the finished plugin. The trace headers are called from index.mjs's
// chat path (they have to land before the request is built); what is left
// here is the daily hook, where the one-time gift rides along with the
// check-in.
export function extendLoomy(plugin) {
  const auth = plugin?.auth
  if (!auth || typeof auth.checkin !== "function") return plugin
  const baseCheckin = auth.checkin
  return {
    ...plugin,
    auth: {
      ...auth,
      async checkin(getAuth) {
        const base = await baseCheckin(getAuth)
        if (base?.outcome === "failed" || base?.outcome === "ineligible") return base
        // a way out for an account whose gifts were claimed elsewhere, and
        // the switch the package's own tests use
        if (process.env.LOOMY_ONBOARDING === "0") return base
        let a = null
        try {
          a = await getAuth()
        } catch {
          return base
        }
        if (!a?.access) return base
        const gift = await claimOnboarding(a.access, a).catch(() => null)
        if (!gift || gift.points <= 0) return base
        const named = ONBOARDING_TASKS.filter((t) => gift.keys.includes(t.key)).map((t) => t.label)
        return {
          ...base,
          outcome: "claimed",
          credit: (Number(base?.credit) || 0) + gift.points,
          message: `${base?.message ? `${base.message}；` : ""}新手任务 ${named.join("、") || `${gift.keys.length} 项`} +${gift.points}`,
        }
      },
    },
  }
}

// for tests
export const _internal = {
  OK,
  AUTH_CODES,
  WIRE_SWITCH,
  WIRE_SWITCHES,
  WIRE_OPTION,
  wireOn,
  gateway,
  apiJson,
  Expired,
}
