// Extras for the Raccoon provider: the pieces index.mjs does not carry yet.
//
// Kept in its own file so that a merge of upstream's index.mjs only has to
// keep three call sites (an import, the rename of the exported function, and
// the wrap at the bottom), not this code. Nothing here runs unless index.mjs
// asks for it.
//
// What lives here:
//   - refresh_conflict (200822) self-healing: re-read the desktop app, reuse
//     a token that changed under us, and only spend a refresh if it didn't
//   - the phone-side first-login grant (a second 3000, independent of the
//     desktop one)
//   - check-in triage: a brand-new account is ineligible, not "already done"
//   - the vision whitelist the catalog's tags get wrong in both directions
//   - thinking, in the shape the desktop app sends it for each model family
//   - the app's own headers, and max_tokens lifted before the request leaves
//   - the wrapper that wires all of it into the finished plugin

import {
  addStreamOptions,
  conversationSessionId,
  dispatchThinking,
  effortToThinking,
  normalizeThinking,
  readOrgCode,
  thinkingLevelOf,
  wireHeaders,
} from "./vendor-wire.mjs"

// re-exported so callers and tests reach the request shape through one module
export {
  addStreamOptions,
  conversationSessionId,
  dispatchThinking,
  effortToThinking,
  normalizeThinking,
  readOrgCode,
  thinkingLevelOf,
  wireHeaders,
}

const MOBILE_GRANT_PATH = "/api/web/mobile/v1/login/points/grant"

// The mobile grant is the same Bearer token, but the endpoint only answers
// a phone build. rsfree measured both headers as load-bearing
// (internal/upstream/account.go:333-347); the iOS/Android pair below is what
// its own client sends.
export const MOBILE_CLIENT_HEADERS = {
  "x-client-platform": "app-android",
  "x-client-version": "v1.0.3",
}

// ── the vision whitelist ───────────────────────────────────────────────────
//
// The catalog's `tags` are Raccoon-Auto's picker preferences, not a statement
// about reading images (modelmux PROTOCOL.md:443-444). Measured 2026-10-06,
// six models, same picture, same question (eghrhegpe
// test/baselines/raccoon-contract.json visionProbe — the only baseline there
// that is not the catalog's own declaration): sn-deepseek-v4-1-flash read
// 5/5, sn-glm-5-3-flash 1/1, sn-glm-5-3 1/3 because the gateway has three
// fallback nodes and some are text-only.
//
// `undefined` means "no measurement": those keep whatever the catalog said.
export const VISION_MEASURED = {
  "sn-deepseek-v4-1-flash": true,
  "sn-deepseek-v4-1-flash-1017": true,
  "sn-glm-5-3-flash": true,
  "sn-glm-5-3": false,
}

export function visionOf(id, declared) {
  const known = VISION_MEASURED[String(id ?? "").trim()]
  return known === undefined ? declared === true : known
}

// The fallback table's own three entries, corrected. index.mjs's
// FALLBACK_MODELS is left exactly as upstream wrote it; this is what the
// wrapper substitutes when it builds the picker's config.
export const FALLBACK_IMAGES_FIX = {
  "sn-glm-5-3": false,
  "sn-glm-5-3-flash": true,
  "sn-deepseek-v4-1-flash": true,
}

// ── request body fixes ─────────────────────────────────────────────────────

// Thinking used to be rewritten here as one rule for every model: read the
// level off the body and write it to extra_body.thinking.type. The app does
// not do that — it decides by model family, and only deepseek and doubao read
// `thinking` at all (box_agent/llm/openai_client.py:127). The rewrite now
// lives in vendor-wire.mjs with the rest of the app's request shape, and this
// loader calls it.

// Thinking tokens are billed inside max_tokens, and the catalog's reasoning
// flag is not reliable enough to decide per model, so the floor goes on for
// everyone (rsfree internal/upstream/bodyfix.go:5-15). 16 or 512 came back
// empty with finish_reason=length (its AGENTS.md:46).
// The three names a reply length is asked for under. `/chat/completions`
// callers send the first two; a caller speaking the Responses API sends the
// third, and it was the one this floor used to miss — the request went out at
// 16 tokens and came back empty with finish_reason=length, which is the
// failure the floor exists to prevent. All three are lifted when present.
export const OUTPUT_LENGTH_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"]

export const MIN_OUTPUT_TOKENS = 2048

export function liftMaxTokens(body, floor = MIN_OUTPUT_TOKENS) {
  if (!body || typeof body !== "object") return false
  let touched = false
  for (const field of OUTPUT_LENGTH_FIELDS) {
    if (!(field in body)) continue
    const now = Number(body[field])
    if (!Number.isFinite(now) || now >= floor) continue
    body[field] = floor
    touched = true
  }
  return touched
}

// ── refresh_conflict (200822) self-healing ─────────────────────────────────
//
// The desktop app rotates the refresh token whenever it runs, so a seat's
// stored one is often already spent. zhlcba's three steps
// (src/auth.ts:417-445): if the app now holds a different access token that
// is still valid, use it and never touch the refresh endpoint; if only the
// refresh token moved, refresh with the new one; if neither helped but the
// old access token still has time on it, keep using it.
export function isConflict(err) {
  const text = `${err?.message ?? err ?? ""}`
  return /refresh_conflict|200822/.test(text)
}

const USABLE_MS = 30_000

export function stillUsable(auth, now = Date.now()) {
  const exp = Number(auth?.expires) || 0
  return exp > now + USABLE_MS
}

// Called when the refresh endpoint answered 200822 / refresh_conflict: the
// desktop app rotated the token, so the one on the seat is already spent.
// Returns the credential to carry on with, or rethrows when nothing helps.
export async function healConflict(auth, err, deps) {
  if (!isConflict(err)) throw err
  const { readDesktop, refreshOnce } = deps
  let reread = null
  try {
    reread = typeof readDesktop === "function" ? readDesktop() : null
  } catch {}

  // 1. the app holds a newer access token that is still good: use it, and
  //    never touch the refresh endpoint (that is what just failed)
  if (reread?.access && reread.access !== auth?.access && stillUsable(reread)) {
    return {
      access: reread.access,
      refresh: reread.refresh || auth?.refresh || "",
      expires: Number(reread.expires) || 0,
      ...(reread.uid ? { uid: reread.uid } : {}),
      ...(reread.name ? { name: reread.name } : {}),
    }
  }
  // 2. only the refresh token moved: refresh once with the new one
  if (reread?.refresh && reread.refresh !== auth?.refresh && typeof refreshOnce === "function") {
    try {
      return await refreshOnce(reread.refresh)
    } catch {}
  }
  // 3. neither helped, but the token on the seat still has time on it
  if (stillUsable(auth)) {
    return {
      access: auth.access,
      refresh: auth.refresh,
      expires: Number(auth.expires) || 0,
      ...(auth.uid ? { uid: auth.uid } : {}),
      ...(auth.name ? { name: auth.name } : {}),
    }
  }
  throw err
}

// The default refreshOnce: the same endpoint and body the base file uses, so
// healing does not depend on reaching into its module scope.
export function makeRefreshOnce() {
  const base = (process.env.RACCOON_AUTH_API_BASE || `${(process.env.RACCOON_MAIN_SITE_URL || "https://xiaohuanxiong.com").replace(/\/+$/, "")}/api/web/auth/v1`).replace(/\/+$/, "")
  return async (refreshToken) => {
    const res = await fetch(`${base}/refresh`, {
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
      const err = new Error(`商汤小浣熊刷新 Token 失败: ${payload?.message ?? `HTTP ${res.status}`}`)
      if (res.status >= 400 && res.status < 500) err.signIn = "expired"
      throw err
    }
    const data = payload?.data ?? {}
    const access = String(data?.access_token ?? "").replace(/^Bearer\s+/i, "")
    if (!access) {
      const err = new Error("商汤小浣熊刷新 Token 失败: 未返回新 Token")
      err.signIn = "expired"
      throw err
    }
    let expires = 0
    try {
      const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"))
      expires = Number(claims?.exp) > 0 ? Number(claims.exp) * 1000 : 0
    } catch {}
    const refresh = String(data?.refresh_token ?? "").replace(/^Bearer\s+/i, "") || refreshToken
    return { access, refresh, expires }
  }
}

// ── check-in triage ────────────────────────────────────────────────────────
//
// magpie's contract has six outcomes (README.md:270-300, :292 lists them).
// The package only ever answered claimed/done/failed, so a brand-new account
// whose day had no grant yet was reported "今日已签到" — a quiet lie, since
// nothing had been paid. rsfree's ordering
// (internal/scheduler/scheduler.go:246-256): a day with no grant and a fresh
// account is ineligible; a day with no grant and history is pending.
//
// `history` here is what the bills read told us: were there any grant bills
// at all, ever, beyond today's window.
export function triageCheckin({ credit = 0, beforeKnown = true, everGranted = null, accountAgeDays = null }) {
  if (credit > 0) return "claimed"
  if (!beforeKnown) return "done"
  // Only a fresh account is the case this is for: its grant has not been paid
  // yet, so "already done" is a lie. An older account whose bills hold no
  // grant at all is a read we do not understand, and staying with the base
  // file's verdict is the safer answer.
  if (everGranted === false && accountAgeDays != null && accountAgeDays <= 1) return "ineligible"
  return "done"
}

// ── the phone-side grant ───────────────────────────────────────────────────

export async function claimMobileGrant(token, opts = {}) {
  const apiGetJson = opts.apiGetJson
  if (typeof apiGetJson !== "function") return { points: 0, settled: false }
  try {
    const d = await apiGetJson(MOBILE_GRANT_PATH, token, MOBILE_CLIENT_HEADERS, "POST")
    if (d?.granted === true) {
      const pts = Number(d?.popup?.points)
      return { points: Number.isFinite(pts) && pts > 0 ? Math.floor(pts) : 3000, settled: true }
    }
    if (d?.granted === false) return { points: 0, settled: true }
  } catch {}
  return { points: 0, settled: false }
}

// ── the wrapper ────────────────────────────────────────────────────────────

// The URL a chat fetch is aimed at, whichever way it was given: the plugin's
// own loader calls fetch(url, init) and magpie's SDK path passes a Request.
function urlOf(input) {
  if (typeof input === "string") return input
  if (input && typeof input === "object" && typeof input.url === "string") return input.url
  return ""
}

// Wraps the plugin the base file builds. Everything the base file does stays
// exactly as it is; what changes is what the host sees on the way in and out.
export function extendRaccoon(plugin, deps = {}) {
  if (!plugin?.auth) return plugin
  const auth = { ...plugin.auth }
  const out = { ...plugin, auth }

  // the picker: the three fallback entries the measurements contradict
  if (typeof plugin.config === "function") {
    out.config = async (config) => {
      await plugin.config(config)
      const entry = config?.provider?.raccoon
      if (entry?.models) {
        for (const [id, images] of Object.entries(FALLBACK_IMAGES_FIX)) {
          const m = entry.models[id]
          if (!m) continue
          m.attachment = images
          m.modalities = { input: images ? ["text", "image"] : ["text"], output: ["text"] }
        }
      }
      return config
    }
  }

  // the runtime catalog: an `images` the measurements overrule
  if (plugin.provider && typeof plugin.provider.models === "function") {
    const baseModels = plugin.provider.models
    out.provider = {
      ...plugin.provider,
      async models(p, opts) {
        const list = await baseModels.call(plugin.provider, p, opts)
        if (!list || typeof list !== "object") return list
        for (const [id, m] of Object.entries(list)) {
          const measured = VISION_MEASURED[id]
          if (measured === undefined || !m?.capabilities) continue
          m.capabilities.attachment = measured
          m.capabilities.input = { ...(m.capabilities.input ?? {}), image: measured }
        }
        return list
      },
    }
  }

  // the loader: the app's headers, thinking, and max_tokens on the way in
  if (typeof auth.loader === "function") {
    const baseLoader = auth.loader
    auth.loader = async (getAuth) => {
      const made = await baseLoader(getAuth)
      if (!made || typeof made.fetch !== "function") return made
      return {
        ...made,
        async fetch(input, init = {}) {
          let parsed = null
          if (typeof init?.body === "string") {
            try {
              parsed = JSON.parse(init.body)
              let touched = false
              if (dispatchThinking(parsed)) touched = true
              if (liftMaxTokens(parsed)) touched = true
              if (addStreamOptions(parsed)) touched = true
              if (touched) init = { ...init, body: JSON.stringify(parsed) }
            } catch {
              parsed = null
            }
          }
          // The headers go on last so that what the base loader set — the
          // bearer token above all — is already there to be kept. X-Org-Code
          // comes from the auth record's office_identity, when the host's
          // record carries one: the app reads it from the desktop app's own
          // auth.json (box_agent/auth.py:140), which this fork does not open
          // here — a personal account sends no such header either way, and
          // that is the common case.
          let auth = null
          try {
            auth = await getAuth()
          } catch {
            auth = null
          }
          const headers = wireHeaders(init.headers, {
            url: urlOf(input),
            body: parsed,
            orgCode: readOrgCode(auth),
          })
          return made.fetch(input, { ...init, headers })
        },
      }
    }
  }

  // refresh: a 200822 is the desk app having rotated the token, not the end
  // of the sign-in
  if (typeof auth.refresh === "function") {
    const baseRefresh = auth.refresh
    auth.refresh = async (account) => {
      try {
        return await baseRefresh(account)
      } catch (e) {
        if (!isConflict(e)) throw e
        const healed = await healConflict(account, e, {
          readDesktop: deps.readDesktop,
          refreshOnce: deps.refreshOnce ?? makeRefreshOnce(),
        })
        return {
          access: healed.access,
          refresh: healed.refresh,
          expires: healed.expires,
          ...(healed.uid ? { uid: healed.uid } : {}),
          ...(healed.name ? { name: healed.name } : {}),
        }
      }
    }
  }

  // the check-in: the phone grant and the triage
  if (typeof auth.checkin === "function") {
    const baseCheckin = auth.checkin
    auth.checkin = async (getAuth) => {
      const base = await baseCheckin(getAuth)
      if (base?.outcome === "failed") return base
      if (process.env.RACCOON_EXTRAS === "0") return base
      return enrichCheckin(base, getAuth, deps)
    }
  }

  return out
}

// Desktop seats are read-only towards the app and are kept out of magpie's
// auth store too (index.mjs's own comment: a desktop seat keeps the token it
// signed in with), so their phone-grant flag rides in memory the way the base
// file remembers desktopOnboardingSettled.
const desktopMobileSettled = new Set()

async function enrichCheckin(base, getAuth, deps) {
  let a = null
  try {
    a = await getAuth()
  } catch {
    return base
  }
  if (!a?.access) return base

  // the phone grant, once per account, remembered like the desktop one
  const seatKey = a?.uid || a?.accountId || a.access
  const alreadyTried = a?.source === "desktop" ? desktopMobileSettled.has(seatKey) : !!a?.mobileOnboardingSettled
  let mobilePts = 0
  if (!alreadyTried && typeof deps.apiGetJson === "function") {
    const grant = await claimMobileGrant(a.access, deps)
    if (grant.points > 0) mobilePts = grant.points
    if (grant.settled) {
      if (a?.source === "desktop") desktopMobileSettled.add(seatKey)
      else if (typeof deps.saveAuth === "function") {
        try {
          await deps.saveAuth({ ...a, mobileOnboardingSettled: true })
        } catch {}
      }
    }
  }

  if (mobilePts > 0) {
    return {
      ...base,
      outcome: "claimed",
      credit: (Number(base?.credit) || 0) + mobilePts,
      message: `${base?.message ? `${base.message}；` : ""}手机端首次登录奖励 +${mobilePts}`,
    }
  }

  // a "done" that no grant bill backs is not "already checked in" — it is a
  // day the vendor has not paid yet. Only a done is re-read; claimed and the
  // other outcomes are the base file's verdict and stand.
  if (base?.outcome !== "done") return base
  const history = await readGrantHistory(a.access, deps)
  if (history === null) return base
  const verdict = triageCheckin({ credit: 0, beforeKnown: true, everGranted: history.everGranted, accountAgeDays: history.ageDays })
  if (verdict === "ineligible") {
    return {
      outcome: "ineligible",
      message: history.ageDays != null && history.ageDays <= 1
        ? "账号今天刚注册，首次登录奖励还没到账，稍后再试"
        : "这个账号还没有收到过登录奖励，暂无可领取的签到积分",
    }
  }
  return base
}

// Reads the bills once to answer two things: has any grant ever landed, and
// how old is the account (the oldest bill is a lower bound on its age). A
// read that fails answers null, which leaves the base file's verdict alone —
// guessing in either direction would be worse than saying nothing.
async function readGrantHistory(token, deps) {
  if (typeof deps.apiGetJson !== "function") return null
  try {
    const bills = await deps.apiGetJson("/api/web/points/v1/bills?paging.limit=100&paging.offset=0", token)
    const items = Array.isArray(bills?.items) ? bills.items : []
    if (!items.length) return { everGranted: false, ageDays: null }
    const grants = items.filter((x) => Number(x?.points) > 0 && /grant/i.test(String(x?.biz_type ?? "")))
    let oldest = 0
    for (const item of items) {
      const at = Date.parse(String(item?.created_at ?? ""))
      if (Number.isFinite(at) && at > 0 && (!oldest || at < oldest)) oldest = at
    }
    const ageDays = oldest ? Math.floor((Date.now() - oldest) / 86_400_000) : null
    return { everGranted: grants.length > 0, ageDays }
  } catch {
    return null
  }
}

// for tests
export const _internal = {
  MOBILE_GRANT_PATH,
  thinkingLevelOf,
  normalizeThinking,
  effortToThinking,
  dispatchThinking,
  addStreamOptions,
  conversationSessionId,
  readOrgCode,
  wireHeaders,
  desktopMobileSettled,
}
