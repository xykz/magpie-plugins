// Extras for the Loomy provider: the pieces index.mjs does not carry yet.
//
// Kept in its own file (like renew.mjs) so that a merge of upstream's
// index.mjs only has to keep a handful of marked call sites, not this code.
// Nothing here is called unless index.mjs calls it.
//
// What lives here:
//   - the eight onboarding tasks (one-time 10000 points, never claimed before)
//   - the six-to-three thinking-level table (upstream reasoning.rs)
//   - the "does this model read images" table from the live catalog
//     (upstream images.rs; the name rule alone misreads DeepSeek-V4.1-Flash)
//   - the traceparent / loomy-version headers

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const OK = "000000"
const AUTH_CODES = new Set(["020002", "100002"])
const REQUEST_TIMEOUT = 20_000

// The client announces this version; the gateway has only ever been seen to
// check that the header is present (loomy2api constants.py).
export const LOOMY_VERSION = "0.9.38"

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
    headers: { Accept: "application/json", token: session, Authorization: `Bearer ${session}`, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  }
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json;charset=utf-8"
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

// ── thinking levels ────────────────────────────────────────────────────────
//
// Loomy takes three levels. Upstream walks EFFORT_LEVELS
// ["minimal","low","medium","high","xhigh","max"] two at a time
// (loomy/mod.rs reasoning_patch): minimal+low to low, medium+high to medium,
// xhigh+max to high. Fold anything else away so the gateway keeps its default.
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"]

export function foldEffort(level) {
  if (typeof level !== "string") return null
  const rank = EFFORT_LEVELS.indexOf(level.trim().toLowerCase())
  if (rank < 0) return null
  if (rank <= 1) return "low"
  if (rank <= 3) return "medium"
  return "high"
}

export function foldReasoningBody(body) {
  let changed = false
  const apply = (holder, field) => {
    if (typeof holder?.[field] !== "string") return
    const folded = foldEffort(holder[field])
    if (folded === holder[field]) return
    if (folded) holder[field] = folded
    else delete holder[field]
    changed = true
  }
  apply(body, "reasoning_effort")
  if (body?.reasoning && typeof body.reasoning === "object") apply(body.reasoning, "effort")
  return changed
}

// ── which models read images ───────────────────────────────────────────────
//
// The catalog declares it per model (capabilities.vision). The name rule on
// its own is what upstream shipped first and then had to fix: DeepSeek-V4.1-
// Flash declares vision and still matched "deepseek", so two JPEGs became
// 828k characters of base64 text and the prompt went from 332k to 658k tokens
// (loomy/images.rs:12-16, plugins #609's sibling bug).
let visionCache = { base: "", map: null, at: 0 }
const VISION_TTL_MS = 10 * 60 * 1000

export async function visionMap(session, opts = {}) {
  const base = integrationBase()
  const now = Date.now()
  if (!opts.force && visionCache.map && visionCache.base === base && now - visionCache.at < VISION_TTL_MS) {
    return visionCache.map
  }
  const payload = await apiJson("/api/v1/models", session)
  const entries = Array.isArray(payload?.data) ? payload.data : []
  const map = new Map()
  for (const entry of entries) {
    const id = String(entry?.id ?? "").trim()
    if (!id) continue
    map.set(id, entry?.capabilities?.vision === true)
  }
  visionCache = { base, map, at: now }
  return map
}

// True when the images must be sent as <image_base64> markers. A model the
// catalog knows is answered by the catalog; anything else (no catalog yet,
// a model added since, a read failure) keeps the old name rule rather than
// guessing wrong in the other direction.
export async function needsTagFormat(model, session, opts = {}) {
  const name = String(model ?? "").trim()
  if (!name) return false
  try {
    const map = await visionMap(session, opts)
    if (map.has(name)) return map.get(name) !== true
  } catch {}
  return name.toLowerCase().includes("deepseek")
}

// The ids the live catalog lists, or null when it could not be read. The
// gateway answers an unknown model with the default model and a 200
// (xxhhlk/raccoon2api README), so a request for a model that has since been
// retired would quietly be served by a different one and billed as such.
export async function catalogIds(session, opts = {}) {
  try {
    const map = await visionMap(session, opts)
    return map.size ? new Set(map.keys()) : null
  } catch {
    return null
  }
}

// ── tracing headers ────────────────────────────────────────────────────────
//
// Five independent implementations send these on every gateway call; one
// (modelmux, 2026-10-19) reports the calls worked without them. They are
// cheap and idempotent, so they go out; whether the gateway needs them stays
// an open A/B question rather than a claim either way.
export function traceHeaders() {
  const trace = randomUUID().replace(/-/g, "")
  const span = randomUUID().replace(/-/g, "").slice(0, 16)
  return { traceparent: `00-${trace}-${span}-01`, "loomy-version": LOOMY_VERSION }
}

// ── the plugin wrapper ─────────────────────────────────────────────────────

// Wraps the finished plugin. The chat path's header and body fixes are inside
// index.mjs (they have to land before the request is built); what is left is
// the daily hook, where the one-time gift rides along with the check-in.
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
  gateway,
  apiJson,
  visionCache,
  resetVisionCache: () => {
    visionCache = { base: "", map: null, at: 0 }
  },
  Expired,
}
