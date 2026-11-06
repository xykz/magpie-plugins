import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RaccoonAuthPlugin, _internal as raccoon } from "./index.mjs"

const parseCatalog = raccoon.parseCatalog
import {
  FALLBACK_IMAGES_FIX,
  MIN_OUTPUT_TOKENS,
  MOBILE_CLIENT_HEADERS,
  VISION_MEASURED,
  _internal,
  claimMobileGrant,
  dispatchThinking,
  extendRaccoon,
  healConflict,
  isConflict,
  liftMaxTokens,
  makeRefreshOnce,
  stillUsable,
  triageCheckin,
  visionOf,
} from "./extras.mjs"

function fakeJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${h}.${p}.sig`
}

const fresh = () => fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })

let server = null
let tempDir = null

beforeEach(() => {
  process.env.RACCOON_MAIN_SITE_URL = "http://127.0.0.1:9"
})

afterEach(() => {
  server?.stop(true)
  server = null
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
  delete process.env.RACCOON_MAIN_SITE_URL
  delete process.env.RACCOON_BOX_AGENT_CONFIG_DIR
  delete process.env.RACCOON_EXTRAS
})

function startServer(routes) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const handler = routes[`${req.method} ${u.pathname}`] || routes[u.pathname]
      if (!handler) return new Response(JSON.stringify({ code: 404, message: "not found" }), { status: 404 })
      return handler(req, u)
    },
  })
  process.env.RACCOON_MAIN_SITE_URL = `http://127.0.0.1:${server.port}`
  return server
}

// ---- the catalog category filter -------------------------------------------

test("a category that is not chat is left out of the picker", () => {
  const models = parseCatalog({
    code: 0,
    data: {
      categories: [
        {
          type: "chat",
          models: [{ name: "sn-kimi-k3", description: "Kimi-K3", tags: ["general"], params: { context_window: 200000 } }],
        },
        {
          type: "image",
          models: [{ name: "sn-image-gen", description: "生图", tags: ["image"], params: {} }],
        },
        {
          // no type at all: kept, the catalog has been seen both ways
          models: [{ name: "sn-typeless", description: "无分类", tags: [], params: {} }],
        },
      ],
    },
  })
  const ids = models.map((m) => m.id)
  expect(ids).toContain("sn-kimi-k3")
  expect(ids).toContain("sn-typeless")
  expect(ids).not.toContain("sn-image-gen")
})

// ---- the vision whitelist ---------------------------------------------------

test("a measured model keeps the measurement, not the catalog's tag", () => {
  expect(visionOf("sn-glm-5-3", true)).toBe(false)
  expect(visionOf("sn-glm-5-3-flash", false)).toBe(true)
  expect(visionOf("sn-deepseek-v4-1-flash", false)).toBe(true)
  expect(visionOf("sn-deepseek-v4-1-flash-1017", false)).toBe(true)
})

test("a model nobody measured keeps whatever the catalog declared", () => {
  expect(visionOf("sn-kimi-k3", true)).toBe(true)
  expect(visionOf("sn-kimi-k3", false)).toBe(false)
  expect(visionOf("some-new-model", undefined)).toBe(false)
})

test("the fallback fix covers exactly the three entries the measurements contradict", () => {
  expect(FALLBACK_IMAGES_FIX).toEqual({
    "sn-glm-5-3": false,
    "sn-glm-5-3-flash": true,
    "sn-deepseek-v4-1-flash": true,
  })
  // every fixed id is also a measured id; the whitelist has no fourth entry
  expect(Object.keys(VISION_MEASURED).sort()).toEqual(
    ["sn-deepseek-v4-1-flash", "sn-deepseek-v4-1-flash-1017", "sn-glm-5-3", "sn-glm-5-3-flash"].sort(),
  )
})

test("the config the host sees carries the corrected fallback entries", async () => {
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const config = { provider: {} }
  await hooks.config(config)
  const models = config.provider.raccoon.models
  expect(models["sn-glm-5-3"].attachment).toBe(false)
  expect(models["sn-glm-5-3"].modalities.input).toEqual(["text"])
  expect(models["sn-glm-5-3-flash"].attachment).toBe(true)
  expect(models["sn-glm-5-3-flash"].modalities.input).toEqual(["text", "image"])
  expect(models["sn-deepseek-v4-1-flash"].attachment).toBe(true)
  // an entry nobody measured is left as the base file made it
  expect(models["sn-kimi-k3"].attachment).toBe(true)
})

test("the wrapper leaves a config without models alone", async () => {
  const seen = []
  const plugin = {
    config: async (c) => {
      seen.push(c)
    },
    auth: {},
  }
  const out = extendRaccoon(plugin, {})
  const config = {}
  await out.config(config)
  expect(seen.length).toBe(1)
  expect(config).toEqual({})
})

test("the live catalog's capabilities follow the measurement too", async () => {
  const plugin = {
    provider: {
      id: "raccoon",
      models: async () => ({
        "sn-glm-5-3": { capabilities: { attachment: true, input: { text: true, image: true } } },
        "unmeasured": { capabilities: { attachment: true, input: { text: true, image: true } } },
      }),
    },
    auth: {},
  }
  const out = extendRaccoon(plugin, {})
  const list = await out.provider.models({ id: "raccoon" })
  expect(list["sn-glm-5-3"].capabilities.attachment).toBe(false)
  expect(list["sn-glm-5-3"].capabilities.input.image).toBe(false)
  expect(list["unmeasured"].capabilities.attachment).toBe(true)
})

// ---- body fixes -------------------------------------------------------------

test("a deepseek or doubao model gets thinking in extra_body, where it reads it", () => {
  const a = { model: "sn-deepseek-v4-1-flash", thinking: "enabled" }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.extra_body.thinking.type).toBe("enabled")
  expect(a.reasoning_effort).toBeUndefined()

  const b = { model: "doubao-seed-1-6", thinking: { type: "disabled" } }
  expect(dispatchThinking(b)).toBe(true)
  expect(b.extra_body.thinking.type).toBe("disabled")
})

test("qwen is told enable_thinking, not thinking.type", () => {
  // the vendor puts {'enable_thinking': bool} in params['extra_body'], and the
  // SDK folds that container flat — so unlike deepseek (which the vendor wraps
  // one deeper) this arrives as a top-level field
  const a = { model: "qwen3-max", thinking: "enabled" }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.enable_thinking).toBe(true)
  expect(a.extra_body).toBeUndefined()

  const b = { model: "qwen3-max", reasoning_effort: "none" }
  expect(dispatchThinking(b)).toBe(true)
  expect(b.enable_thinking).toBe(false)
})

test("kimi and glm take a reasoning effort, and off is low rather than none", () => {
  const a = { model: "sn-kimi-k3", thinking: "enabled" }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.reasoning_effort).toBe("high")

  const b = { model: "sn-kimi-k3", thinking: "disabled" }
  expect(dispatchThinking(b)).toBe(true)
  expect(b.reasoning_effort).toBe("low")

  const c = { model: "sn-glm-5-3", extra_body: { thinking: "off" } }
  expect(dispatchThinking(c)).toBe(true)
  expect(c.reasoning_effort).toBe("low")
  expect(c.extra_body).toBeUndefined()
})

test("a reasoning effort on a plain model becomes high, not a thinking switch", () => {
  const a = { model: "raccoon-chat-ml-5-5", reasoning_effort: "high" }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.reasoning_effort).toBe("high")
  expect(a.extra_body).toBeUndefined()
})

test("the gemini pair that rejects off is never told off", () => {
  const a = { model: "gemini-2.5-pro", thinking: "disabled" }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.reasoning_effort).toBeUndefined()

  const b = { model: "gemini-2.5-pro", thinking: "enabled" }
  expect(dispatchThinking(b)).toBe(true)
  expect(b.reasoning_effort).toBe("high")

  const c = { model: "gemini-3-pro", thinking: "disabled" }
  expect(dispatchThinking(c)).toBe(true)
  expect(c.reasoning_effort).toBe("none")
})

test("a gpt-6 with function tools is told none however thinking was set", () => {
  const a = { model: "gpt-6-sol", thinking: "enabled", tools: [{ type: "function" }] }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.reasoning_effort).toBe("none")

  const b = { model: "gpt-6-sol", thinking: "enabled", tools: [{ type: "web_search" }] }
  expect(dispatchThinking(b)).toBe(true)
  expect(b.reasoning_effort).toBe("high")
})

test("sensenova defaults to none except the one measured low model", () => {
  const a = { model: "sn-sensenova-6-8-flash-lite", thinking: "disabled" }
  expect(dispatchThinking(a)).toBe(true)
  expect(a.reasoning_effort).toBe("none")

  const b = { model: "sensenova-flash-lite-20260727-v39-fp8-step4k-dpov2-mtp", thinking: "disabled" }
  expect(dispatchThinking(b)).toBe(true)
  expect(b.reasoning_effort).toBe("low")
})

test("a body carrying both shapes ends with one, whichever the model reads", () => {
  const body = {
    model: "sn-deepseek-v4-1-flash",
    extra_body: { thinking: { type: "enabled" } },
    reasoning_effort: "high",
  }
  expect(dispatchThinking(body)).toBe(true)
  expect(body.reasoning_effort).toBeUndefined()
  expect(body.extra_body.thinking.type).toBe("enabled")
})

test("a body that says nothing about thinking is left untouched", () => {
  const body = { model: "sn-kimi-k3", messages: [] }
  expect(dispatchThinking(body)).toBe(false)
  expect(body.extra_body).toBeUndefined()

  const odd = { model: "sn-kimi-k3", thinking: "banana" }
  expect(dispatchThinking(odd)).toBe(false)
  expect(odd.extra_body).toBeUndefined()
})

test("a small max_tokens is lifted to the floor", () => {
  const a = { max_tokens: 16 }
  expect(liftMaxTokens(a)).toBe(true)
  expect(a.max_tokens).toBe(MIN_OUTPUT_TOKENS)

  const b = { max_completion_tokens: 512 }
  expect(liftMaxTokens(b)).toBe(true)
  expect(b.max_completion_tokens).toBe(MIN_OUTPUT_TOKENS)
})

test("a max_tokens already above the floor is left alone", () => {
  const a = { max_tokens: 8192 }
  expect(liftMaxTokens(a)).toBe(false)
  expect(a.max_tokens).toBe(8192)

  const b = {}
  expect(liftMaxTokens(b)).toBe(false)
  expect(b).toEqual({})
})

test("the loader hands the patched body to the vendor", async () => {
  const plugin = {
    auth: {
      loader: async () => ({
        baseURL: "http://x",
        apiKey: "k",
        fetch: async (_input, init) => new Response(init.body, { status: 200 }),
      }),
    },
  }
  const out = extendRaccoon(plugin, {})
  const made = await out.auth.loader(async () => ({}))
  const res = await made.fetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "sn-deepseek-v4-1-flash", max_tokens: 128, thinking: "enabled" }),
  })
  const seen = JSON.parse(await res.text())
  expect(seen.max_tokens).toBe(MIN_OUTPUT_TOKENS)
  expect(seen.extra_body.thinking.type).toBe("enabled")
})

test("the loader gives a kimi body an effort, not a thinking switch", async () => {
  const plugin = {
    auth: {
      loader: async () => ({
        fetch: async (_input, init) => new Response(init.body, { status: 200 }),
      }),
    },
  }
  const out = extendRaccoon(plugin, {})
  const made = await out.auth.loader(async () => ({}))
  const res = await made.fetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "sn-kimi-k3", max_tokens: 100_000, thinking: "enabled" }),
  })
  const seen = JSON.parse(await res.text())
  expect(seen.reasoning_effort).toBe("high")
  expect(seen.extra_body).toBeUndefined()
})

test("a non-JSON body reaches the vendor untouched", async () => {
  const plugin = {
    auth: {
      loader: async () => ({
        fetch: async (_input, init) => new Response(init.body, { status: 200 }),
      }),
    },
  }
  const out = extendRaccoon(plugin, {})
  const made = await out.auth.loader(async () => ({}))
  const res = await made.fetch("/x", { method: "POST", body: "not json" })
  expect(await res.text()).toBe("not json")
})

// ---- refresh_conflict healing ----------------------------------------------

test("a conflict is recognised from the vendor's code or wording", () => {
  expect(isConflict(new Error("商汤小浣熊刷新 Token 失败: refresh_conflict"))).toBe(true)
  expect(isConflict(new Error("code=200822"))).toBe(true)
  expect(isConflict(new Error("HTTP 500"))).toBe(false)
})

test("a token with less than thirty seconds left is not usable", () => {
  expect(stillUsable({ expires: Date.now() + 60_000 })).toBe(true)
  expect(stillUsable({ expires: Date.now() + 10_000 })).toBe(false)
  expect(stillUsable({ expires: 0 })).toBe(false)
  expect(stillUsable({})).toBe(false)
})

test("healing takes the app's newer token without spending the refresh", async () => {
  let refreshed = 0
  const appTok = fresh()
  const got = await healConflict(
    { access: "old", refresh: "R-old", expires: Date.now() - 1000 },
    new Error("refresh_conflict"),
    {
      readDesktop: () => ({ access: appTok, refresh: "R-new", expires: Date.now() + 3_600_000 }),
      refreshOnce: async () => {
        refreshed += 1
        return { access: "nope" }
      },
    },
  )
  expect(got.access).toBe(appTok)
  expect(got.refresh).toBe("R-new")
  expect(refreshed).toBe(0)
})

test("healing refreshes once when only the refresh token moved", async () => {
  let used = null
  const got = await healConflict(
    { access: "same", refresh: "R-old", expires: Date.now() - 1000 },
    new Error("200822"),
    {
      readDesktop: () => ({ access: "same", refresh: "R-new", expires: Date.now() - 1000 }),
      refreshOnce: async (token) => {
        used = token
        return { access: "brand-new", refresh: "R-newer", expires: Date.now() + 3_600_000 }
      },
    },
  )
  expect(used).toBe("R-new")
  expect(got.access).toBe("brand-new")
})

test("healing keeps the old token when it still has time on it", async () => {
  const exp = Date.now() + 600_000
  const got = await healConflict({ access: "old", refresh: "R", expires: exp }, new Error("refresh_conflict"), {
    readDesktop: () => null,
  })
  expect(got.access).toBe("old")
  expect(got.expires).toBe(exp)
})

test("healing rethrows when nothing helps", async () => {
  const err = new Error("refresh_conflict")
  let threw = null
  await healConflict({ access: "old", refresh: "R", expires: Date.now() - 1000 }, err, {
    readDesktop: () => null,
  }).catch((e) => {
    threw = e
  })
  expect(threw).toBe(err)
})

test("a non-conflict error is not ours to heal", async () => {
  const err = new Error("HTTP 500")
  let threw = null
  await healConflict({ access: "old", refresh: "R", expires: Date.now() + 600_000 }, err, {}).catch((e) => {
    threw = e
  })
  expect(threw).toBe(err)
})

test("a refresh that answers 200822 heals through the app instead of signing out", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-extras-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const appTok = fakeJwt({ iss: "74350b", name: "Desk", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ access_token: appTok, refresh_token: "R-app" }))

  let refreshCalls = 0
  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCalls += 1
      return Response.json({ code: 200822, message: "refresh_conflict" }, { status: 400 })
    },
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const got = await hooks.auth.refresh({
    type: "oauth",
    access: "spent",
    refresh: "R-spent",
    expires: Date.now() - 1000,
  })
  expect(refreshCalls).toBe(1)
  expect(got.access).toBe(appTok)
  // the desktop app's auth.json carries no refresh token (its access token is
  // an IAM ticket), so the seat keeps the one it signed in with
  expect(got.refresh).toBe("R-spent")
})

test("makeRefreshOnce posts the token and reads the new one back", async () => {
  const next = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 7200 })
  startServer({
    "POST /api/web/auth/v1/refresh": () => Response.json({ code: 0, data: { access_token: next, refresh_token: "R2" } }),
  })
  const got = await makeRefreshOnce()("R1")
  expect(got.access).toBe(next)
  expect(got.refresh).toBe("R2")
  expect(got.expires).toBeGreaterThan(Date.now() + 3_600_000)
})

// ---- check-in triage --------------------------------------------------------

test("a claim is a claim no matter what the history says", () => {
  expect(triageCheckin({ credit: 300, everGranted: false, accountAgeDays: 0 })).toBe("claimed")
})

test("a brand-new account with no grant is ineligible, not already done", () => {
  expect(triageCheckin({ credit: 0, everGranted: false, accountAgeDays: 0 })).toBe("ineligible")
  expect(triageCheckin({ credit: 0, everGranted: false, accountAgeDays: 1 })).toBe("ineligible")
})

test("an account with history keeps the base verdict", () => {
  expect(triageCheckin({ credit: 0, everGranted: true, accountAgeDays: 40 })).toBe("done")
})

test("an unreadable history keeps the base verdict rather than guessing", () => {
  expect(triageCheckin({ credit: 0, everGranted: false, accountAgeDays: null })).toBe("done")
  expect(triageCheckin({ credit: 0, everGranted: null, accountAgeDays: 0 })).toBe("done")
})

test("a check-in whose before-snapshot failed is never downgraded", () => {
  expect(triageCheckin({ credit: 0, beforeKnown: false, everGranted: false, accountAgeDays: 0 })).toBe("done")
})

// ---- the phone-side grant ---------------------------------------------------

test("the phone grant asks with the Android identity headers", async () => {
  let seen = null
  startServer({
    "POST /api/web/mobile/v1/login/points/grant": (req) => {
      seen = Object.fromEntries(req.headers)
      return Response.json({ code: 0, data: { granted: true, popup: { source: "mobile", points: 3000 } } })
    },
  })
  const apiGetJson = async (path, token, headers, method) => {
    const res = await fetch(`${process.env.RACCOON_MAIN_SITE_URL}${path}`, { method, headers: { ...headers } })
    return (await res.json()).data
  }
  const got = await claimMobileGrant("tok", { apiGetJson })
  expect(got).toEqual({ points: 3000, settled: true })
  expect(seen["x-client-platform"]).toBe("app-android")
  expect(seen["x-client-version"]).toBe("v1.0.3")
  expect(MOBILE_CLIENT_HEADERS["x-client-platform"]).toBe("app-android")
})

test("the phone grant takes the popup's number and falls back to 3000", async () => {
  const withPopup = async () => ({ granted: true, popup: { points: 1200 } })
  expect(await claimMobileGrant("t", { apiGetJson: withPopup })).toEqual({ points: 1200, settled: true })

  const noPopup = async () => ({ granted: true })
  expect(await claimMobileGrant("t", { apiGetJson: noPopup })).toEqual({ points: 3000, settled: true })

  const zeroPopup = async () => ({ granted: true, popup: { points: 0 } })
  expect(await claimMobileGrant("t", { apiGetJson: zeroPopup })).toEqual({ points: 3000, settled: true })
})

test("a refused phone grant is settled with nothing, a failed one is not settled", async () => {
  const refused = async () => ({ granted: false })
  expect(await claimMobileGrant("t", { apiGetJson: refused })).toEqual({ points: 0, settled: true })

  const broken = async () => {
    throw new Error("500")
  }
  expect(await claimMobileGrant("t", { apiGetJson: broken })).toEqual({ points: 0, settled: false })

  expect(await claimMobileGrant("t", {})).toEqual({ points: 0, settled: false })
})

// ---- the check-in wrapper ---------------------------------------------------

function stubPlugin(verdict) {
  return {
    provider: { id: "raccoon" },
    auth: {
      checkin: async () => verdict,
    },
  }
}

const authWith = (extra = {}) => ({
  type: "oauth",
  access: "tok",
  refresh: "R",
  expires: Date.now() + 3_600_000,
  ...extra,
})

test("the phone grant is added to the day's claim and remembered once", async () => {
  const saves = []
  let grants = 0
  const deps = {
    apiGetJson: async () => {
      grants += 1
      return { granted: true, popup: { points: 3000 } }
    },
    saveAuth: async (body) => {
      saves.push(body)
    },
  }
  const out = extendRaccoon(stubPlugin({ outcome: "claimed", credit: 300 }), deps)

  const first = await out.auth.checkin(async () => authWith())
  expect(first.outcome).toBe("claimed")
  expect(first.credit).toBe(3300)
  expect(first.message).toContain("手机端首次登录奖励 +3000")
  expect(grants).toBe(1)
  expect(saves.at(-1).mobileOnboardingSettled).toBe(true)

  // a record that already carries the flag is not asked again
  const second = await out.auth.checkin(async () => authWith({ mobileOnboardingSettled: true }))
  expect(second.credit).toBe(300)
  expect(grants).toBe(1)
})

test("a refused phone grant is remembered so it is not asked again", async () => {
  let grants = 0
  const saves = []
  const out = extendRaccoon(stubPlugin({ outcome: "done" }), {
    apiGetJson: async (path) => {
      if (!path.includes("/mobile/v1/")) return { items: [] }
      grants += 1
      return { granted: false }
    },
    saveAuth: async (b) => {
      saves.push(b)
    },
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("done")
  expect(grants).toBe(1)
  expect(saves.at(-1).mobileOnboardingSettled).toBe(true)
})

test("a failed phone grant is not remembered, so the next check-in asks again", async () => {
  const saves = []
  const out = extendRaccoon(stubPlugin({ outcome: "done" }), {
    apiGetJson: async () => {
      throw new Error("500")
    },
    saveAuth: async (b) => {
      saves.push(b)
    },
  })
  await out.auth.checkin(async () => authWith())
  expect(saves.length).toBe(0)
})

test("a desktop seat remembers the phone grant in memory, not in the record", async () => {
  const saves = []
  let grants = 0
  _internal.desktopMobileSettled.clear()
  const out = extendRaccoon(stubPlugin({ outcome: "done" }), {
    apiGetJson: async (path) => {
      if (!path.includes("/mobile/v1/")) return { items: [{ biz_type: "daily_grant", points: 300, created_at: new Date().toISOString() }] }
      grants += 1
      return { granted: true, popup: { points: 3000 } }
    },
    saveAuth: async (b) => {
      saves.push(b)
    },
  })
  const seat = () => authWith({ source: "desktop", uid: "7615755" })
  const first = await out.auth.checkin(seat)
  expect(first.outcome).toBe("claimed")
  expect(first.credit).toBe(3000)
  const second = await out.auth.checkin(seat)
  expect(second.outcome).toBe("done")
  expect(grants).toBe(1)
  // a desktop seat is never written through the client
  expect(saves.length).toBe(0)
  _internal.desktopMobileSettled.clear()
})

test("a failed check-in is passed through without asking the vendor anything", async () => {
  let calls = 0
  const out = extendRaccoon(stubPlugin({ outcome: "failed", message: "上游 500" }), {
    apiGetJson: async () => {
      calls += 1
      return { granted: true }
    },
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("failed")
  expect(calls).toBe(0)
})

test("RACCOON_EXTRAS=0 turns the additions off", async () => {
  process.env.RACCOON_EXTRAS = "0"
  let calls = 0
  const out = extendRaccoon(stubPlugin({ outcome: "done" }), {
    apiGetJson: async () => {
      calls += 1
      return { granted: true }
    },
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("done")
  expect(calls).toBe(0)
})

test("a done on a brand-new account with no grant becomes ineligible", async () => {
  const now = new Date().toISOString()
  const out = extendRaccoon(stubPlugin({ outcome: "done", message: "今日已签到" }), {
    apiGetJson: async (path) => {
      if (path.includes("/mobile/v1/")) return { granted: false }
      return { items: [{ biz_type: "chat_debit", points: -20, created_at: now }] }
    },
    saveAuth: async () => {},
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("ineligible")
  expect(got.message).toContain("刚注册")
})

test("a done on an old account stays done", async () => {
  const out = extendRaccoon(stubPlugin({ outcome: "done", message: "今日已签到" }), {
    apiGetJson: async (path) => {
      if (path.includes("/mobile/v1/")) return { granted: false }
      return { items: [{ biz_type: "chat_debit", points: -20, created_at: "2026-09-01T08:00:00+08:00" }] }
    },
    saveAuth: async () => {},
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("done")
  expect(got.message).toBe("今日已签到")
})

test("an account that has been granted before keeps its done even when young", async () => {
  const now = new Date().toISOString()
  const out = extendRaccoon(stubPlugin({ outcome: "done" }), {
    apiGetJson: async (path) => {
      if (path.includes("/mobile/v1/")) return { granted: false }
      return { items: [{ biz_type: "daily_grant", points: 300, created_at: now }] }
    },
    saveAuth: async () => {},
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("done")
})

test("a history read that fails leaves the base verdict alone", async () => {
  const out = extendRaccoon(stubPlugin({ outcome: "done", message: "今日已签到" }), {
    apiGetJson: async (path) => {
      if (path.includes("/mobile/v1/")) return { granted: false }
      throw new Error("502")
    },
    saveAuth: async () => {},
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("done")
  expect(got.message).toBe("今日已签到")
})

test("a claimed check-in is never re-triaged", async () => {
  const out = extendRaccoon(stubPlugin({ outcome: "claimed", credit: 300 }), {
    apiGetJson: async (path) => {
      if (path.includes("/mobile/v1/")) return { granted: false }
      return { items: [] }
    },
    saveAuth: async () => {},
  })
  const got = await out.auth.checkin(async () => authWith())
  expect(got.outcome).toBe("claimed")
  expect(got.credit).toBe(300)
})

test("a plugin without a check-in is wrapped without one", async () => {
  const plugin = { provider: { id: "raccoon" }, auth: { provider: "raccoon" } }
  const out = extendRaccoon(plugin, {})
  expect(out.auth.checkin).toBeUndefined()
  expect(out.provider).toBe(plugin.provider)
})

test("extendRaccoon returns a plugin that has no auth untouched", () => {
  const plugin = { config: async () => {} }
  expect(extendRaccoon(plugin, {})).toBe(plugin)
})
