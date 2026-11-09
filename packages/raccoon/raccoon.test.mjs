import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { RaccoonAuthPlugin, _internal } from "./index.mjs"

function fakeJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${h}.${p}.sig`
}

let server = null
let tempDir = null

// No test may reach the real network: a test that starts no server points at a
// port nothing listens on.
// (accountPhoneOf reads user_info; pointing at the real site made the suite
// depend on the network — review #486, point 1.)
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
  delete process.env.RACCOON_USAGE_TTL_MS
  delete process.env.RACCOON_BILLS_TTL_MS
  delete process.env.RACCOON_ENTITLEMENT_TTL_MS
  _internal.renewed.clear()
  _internal.renewing.clear()
  _internal.popupGrantReported.clear()
  _internal.checkinInFlight.clear()
  // usage answers from a young reading (RACCOON_USAGE_TTL_MS, minutes), so a
  // reading taken by one test would answer the next one's call: each test
  // starts from no readings at all.
  _internal.usageCache.clear()
  _internal.usageInFlight.clear()
  _internal.usageFailed.clear()
  _internal.entitlementCache.clear()
  _internal.billsCache.clear()
  _internal.billsHealedAt.clear()
})

function startServer(routes) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const key = `${req.method} ${u.pathname}`
      const handler = routes[key] || routes[u.pathname]
      if (!handler) return new Response(JSON.stringify({ code: 404, message: "not found" }), { status: 404 })
      return handler(req, u)
    },
  })
  process.env.RACCOON_MAIN_SITE_URL = `http://127.0.0.1:${server.port}`
  return server
}

test("decodes JWT claims and converts hex user id to decimal", () => {
  const tok = fakeJwt({ iss: "74350b", name: "RaccoonMason", exp: 1800000000 })
  const claims = _internal.decodeJwtClaims("Bearer " + tok)
  expect(_internal.extractUserId(claims)).toBe("7615755")
  expect(_internal.extractDisplayName(claims)).toBe("RaccoonMason")
  expect(_internal.jwtExpiryMs(tok)).toBe(1800000000 * 1000)
})

test("parses model_catalog entries with effective multiplier and limited_free", () => {
  const models = _internal.parseCatalog({
    code: 0,
    data: {
      categories: [
        {
          type: "chat",
          models: [
            {
              name: "raccoon-8c4485",
              description: "Raccoon-Work",
              tags: ["general", "code", "vision", "reasoning"],
              params: { context_window: 1000000, max_tokens: 100000 },
              billing_multiplier: 1,
              billing_effective_multiplier: 1,
            },
            {
              name: "sn-sensenova-6-8-flash",
              description: "SenseNova-6.8-Flash",
              tags: ["general", "vision", "fast"],
              params: { context_window: 256000, max_tokens: 63999 },
              billing_multiplier: 0.5,
              billing_effective_multiplier: 0,
              billing_status: "limited_free",
            },
          ],
        },
      ],
    },
  })
  expect(models.find((m) => m.id === "raccoon-8c4485")).toMatchObject({
    id: "raccoon-8c4485",
    name: "Raccoon-Work",
    context: 1000000,
    output: 100000,
    images: true,
    free: false,
    rate: 1,
  })
  expect(models.find((m) => m.id === "sn-sensenova-6-8-flash")).toMatchObject({
    id: "sn-sensenova-6-8-flash",
    name: "SenseNova-6.8-Flash",
    images: true,
    free: true,
    rate: 0,
    rateWas: 0.5,
  })
})

test("parses callback URL and direct tokens", () => {
  expect(_internal.parseCallbackInput("office-raccoon://auth/callback?code=abc123&state=s1", "s1")).toEqual({
    code: "abc123",
  })
  expect(() => _internal.parseCallbackInput("office-raccoon://auth/callback?code=abc123&state=wrong", "s1")).toThrow()
  const tok = fakeJwt({ iss: "74350b", exp: 1800000000 })
  expect(_internal.parseCallbackInput(tok, "s1")).toEqual({
    direct: { access: tok, refresh: "" },
  })
})

test("rewrites SSE chunk model name and normalizes CRLF endings", async () => {
  const body = 'data: {"id":"1","model":"internal-raccoon","choices":[{"delta":{"content":"hi"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
  const orig = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
  const rewritten = await _internal.rewriteSseModel(orig, "sn-glm-5-3", "kept")
  expect(rewritten.headers.get("x-magpie-sign-in")).toBe("kept")
  const text = await rewritten.text()
  expect(text).toContain('"model":"sn-glm-5-3"')
  expect(text).not.toContain("\r")
  expect(text).toContain("data: [DONE]")
})

test("refresh 400 params_invalid_error marks signIn expired and uses details", async () => {
  startServer({
    "POST /api/web/auth/v1/refresh": () =>
      new Response(
        JSON.stringify({
          code: 100002,
          message: "params_invalid_error",
          details: "refresh token is invalid or expired",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const staleTok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) - 10 })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: staleTok,
    refresh: "bad-rt",
    expires: Date.now() - 10_000,
  }))
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("refresh token is invalid or expired")
})

test("desktop sign-in is read-only and never writes or refreshes auth.json", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const staleTok = fakeJwt({ iss: "74350b", name: "DeskUser", exp: Math.floor(Date.now() / 1000) - 10 })
  const originalContent = JSON.stringify({ access_token: staleTok, refresh_token: "D1" }, null, 2)
  writeFileSync(authFile, originalContent)

  let refreshCalled = false
  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCalled = true
      return Response.json({ code: 0, data: { access_token: "x", refresh_token: "D2" } })
    },
  })

  // a seat with no token of its own, as one added before the seat's own
  // token was saved: the app's stale account is read, never written
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const res = await hooks.auth.usage(async () => ({ type: "oauth", source: "desktop" }))
  expect(refreshCalled).toBe(false)
  expect(res.signIn).toBe("expired")
  expect(await Bun.file(authFile).text()).toBe(originalContent)
})

test("a desktop seat is named by its phone, not by the app's `name`", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  writeFileSync(join(tempDir, "auth.json"), JSON.stringify({
    access_token: fakeJwt({ iss: "74350b", name: "raccoon-pu-01a1365c", exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "D1",
  }))
  startServer({
    "/api/web/auth/v1/user_info": () => Response.json({ code: 0, data: { phone: "13800138000", name: "RaccoonBenjamin" } }),
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const method = hooks.auth.methods.find((m) => m.label?.includes("desktop") || m.label?.includes("桌面"))
  const flow = await method.authorize()
  const res = await flow.callback()
  expect(res.type).toBe("success")
  // accountId stays main's computation (the app's name); the phone is a record field
  expect(res.accountId).toBe("raccoon-pu-01a1365c")
  expect(res.phone).toBe("138****8000")
  expect(res.cardName).toBe("138****8000")
  expect(res.uid).toBeTruthy()
})

// Where Raccoon desktop 1.1.3 keeps auth.json, read from its app.asar:
// clientProfile.ts puts the box-agent home at <profile>/agent, the profile at
// app.getPath("appData")/office-raccoon on macOS and at ~/.office-raccoon on
// Windows; older installs keep ~/.box-agent/config/auth.json.
test("desktop auth.json candidates follow each OS's profile layout", () => {
  const home = "/h"
  expect(_internal.desktopAuthCandidates(home, "darwin", {})).toEqual([
    join(home, "Library", "Application Support", "office-raccoon", "agent", "config", "auth.json"),
    join(home, ".box-agent", "config", "auth.json"),
  ])
  expect(_internal.desktopAuthCandidates(home, "win32", {})).toEqual([
    join(home, ".office-raccoon", "agent", "config", "auth.json"),
    join(home, "AppData", "Roaming", "office-raccoon", "agent", "config", "auth.json"),
    join(home, ".box-agent", "config", "auth.json"),
  ])
  expect(_internal.desktopAuthCandidates(home, "win32", { APPDATA: "/ad" })[1]).toBe(
    join("/ad", "office-raccoon", "agent", "config", "auth.json"),
  )
  expect(_internal.desktopAuthCandidates(home, "linux", {})).toEqual([
    join(home, ".config", "office-raccoon", "agent", "config", "auth.json"),
    join(home, ".box-agent", "config", "auth.json"),
  ])
  expect(_internal.desktopAuthCandidates(home, "darwin", { BOX_AGENT_CONFIG_DIR: "/custom" })).toEqual([
    join("/custom", "auth.json"),
  ])
})

test("desktop auth.json is found at both the current and the legacy layout", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-home-"))
  const tok = fakeJwt({ iss: "74350b", name: "DeskUser", exp: Math.floor(Date.now() / 1000) + 3600 })
  const body = JSON.stringify({ access_token: tok, office_identity: "personal" })
  const candidates = _internal.desktopAuthCandidates(tempDir, "darwin", {})
  const [current, legacy] = candidates

  expect(_internal.desktopAuthPath(candidates)).toBe(current) // neither: the first, read as signed out

  // the box-agent build keeps the file here
  mkdirSync(dirname(legacy), { recursive: true })
  writeFileSync(legacy, body)
  expect(_internal.desktopAuthPath(candidates)).toBe(legacy)

  // the profile build writes here instead; it wins when both exist
  mkdirSync(dirname(current), { recursive: true })
  writeFileSync(current, body)
  expect(_internal.desktopAuthPath(candidates)).toBe(current)

  // and the sign-in reads it, through the env override this file's other
  // desktop tests use (Bun's homedir() can't be moved after start)
  const prev = process.env.RACCOON_BOX_AGENT_CONFIG_DIR
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = dirname(current)
  try {
    const hooks = await RaccoonAuthPlugin({ client: {} })
    const method = hooks.auth.methods.find((m) => m.label.includes("桌面端"))
    const res = await (await method.authorize()).callback()
    expect(res.type).toBe("success")
    expect(res.access).toBe(tok)
  } finally {
    if (prev === undefined) delete process.env.RACCOON_BOX_AGENT_CONFIG_DIR
    else process.env.RACCOON_BOX_AGENT_CONFIG_DIR = prev
  }
})

test("usage does not invent 300/9000 floors when bills do not cover balance", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/points/v1/balance": () =>
      Response.json({
        code: 0,
        data: { available_points: 500, daily_points: 0, reward_points: 500, monthly_points: 0, topup_points: 0 },
      }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "rt1",
    expires: Date.now() + 3600_000,
  }))
  // no floors are invented: the day's bucket is 0 and the reward's 500 is
  // permanent, each said as itself (#3950, and the day's own split)
  expect(u.windows).toEqual([
    { name: "每日积分", used: 100, unit: "credits", resetsAt: expect.any(String), span: 86400 },
    { name: "永久积分", balance: 500, unit: "credits" },
  ])
})

test("usage keeps the day's window aside while it pays, and lets the wallet weigh once it does not", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const reply = (daily, reward) => () =>
    Response.json({
      code: 0,
      data: { available_points: daily + reward, daily_points: daily, reward_points: reward, monthly_points: 0, topup_points: 0 },
    })
  const bills = () =>
    Response.json({
      code: 0,
      data: {
        items: [
          { bill_id: "d1", biz_type: "daily_grant", points: 300, expire_at: "2029-10-18T23:59:59+08:00" },
          { bill_id: "r1", biz_type: "reward_grant", points: 9000 },
        ],
      },
    })
  const read = async (balanceRE, billsRE) => {
    // three readings of one account inside the usage TTL: the cache would
    // answer the second and third from the first (RACCOON_USAGE_TTL_MS)
    process.env.RACCOON_USAGE_TTL_MS = "0"
    startServer({
      "GET /api/web/points/v1/balance": balanceRE,
      "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
      "GET /api/web/points/v1/bills": billsRE,
    })
    const hooks = await RaccoonAuthPlugin({ client: {} })
    return hooks.auth.usage(async () => ({ type: "oauth", access: validTok, refresh: "rt1", expires: Date.now() + 3600_000 }))
  }
  // the day still holds something: the wallet must not weigh at all, or the
  // pool parks on whichever account keeps the most permanent points
  const paying = await read(reply(300, 9000), bills)
  expect(paying.windows[0]).toMatchObject({ name: "每日积分", used: 0, display: "0 / 300", amount: 0, limit: 300, span: 86400 })
  expect(paying.windows[1]).toEqual({ name: "永久积分", balance: 9000, unit: "credits", aside: true })

  // the day is spent: the wallet joins beside a share at 100, so it never
  // outranks an account whose day still has something in it
  const spent = await read(reply(0, 9000), bills)
  expect(spent.windows[0]).toMatchObject({ name: "每日积分", used: 100 })
  expect(spent.windows[1]).toEqual({ name: "永久积分", balance: 9000, unit: "credits" })

  // an empty wallet is no window at all: a lone balance of 0 reads as used up
  const none = await read(reply(0, 0), bills)
  expect(none.windows.map((w) => w.name)).toEqual(["每日积分"])
})

test("a balance reply that names no balance makes no window, an unknown not a zero", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    // the reply is a success with no number in it: 0 would claim the
    // account is spent out, and routing would bench it
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "rt1",
    expires: Date.now() + 3600_000,
  }))
  expect(u.windows).toEqual([])
})

test("the name usage puts on the card is the phone, not the JWT's name (review #486)", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "RaccoonBenjamin", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/points/v1/balance": () =>
      Response.json({
        code: 0,
        data: { available_points: 500, daily_points: 0, reward_points: 500, monthly_points: 0, topup_points: 0 },
      }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  // magpie shows usage's user as the card's name; the JWT's name is on the
  // record too, and the phone must win
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "rt1",
    expires: Date.now() + 3600_000,
    accountId: "Raccoon-7615755",
    phone: "138****8000",
    cardName: "138****8000",
    name: "RaccoonBenjamin",
  }))
  expect(u.user).toBe("138****8000")
})

test("usage reports the day's share and the permanent wallet apart, from the vendor's own buckets", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/points/v1/balance": () =>
      Response.json({
        code: 0,
        data: { available_points: 9519, daily_points: 519, reward_points: 9000, monthly_points: 0, topup_points: 0 },
      }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () =>
      Response.json({
        code: 0,
        data: {
          items: [
            { bill_id: "b1", biz_type: "daily_grant", points: 300, expire_at: "2029-10-18T23:59:59+08:00" },
            { bill_id: "b2", biz_type: "daily_grant", points: 300, expire_at: "2029-10-17T23:59:59+08:00" },
            { bill_id: "b3", biz_type: "reward_grant", points: 9000 },
          ],
        },
      }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "rt1",
    expires: Date.now() + 3600_000,
  }))
  expect(u.balance).toBeUndefined()
  // 519 of the day's 600 is still there, so the wallet is aside: draining the
  // day across the pool comes before touching anyone's permanent points
  expect(u.windows).toEqual([
    {
      name: "每日积分",
      used: 13.5,
      display: "81 / 600",
      amount: 81,
      limit: 600,
      unit: "credits",
      resetsAt: expect.any(String),
      span: 86400,
      runsOutAt: "2029-10-17T15:59:59.000Z",
      runsOut: 300,
    },
    { name: "永久积分", balance: 9000, unit: "credits", aside: true },
  ])
  // the day's limit is the grants that lapse, not every grant: counting the
  // 9000 reward into it would make the day read 9294 / 9600 used
  expect(u.windows[0].limit).toBe(600)
})

test("usage reads bills past the newest 200 rows, where the large grants are (plugins #223)", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  // newest first, as the endpoint answers: 1200 spends, then the grants
  const items = []
  for (let i = 0; i < 1200; i++) items.push({ bill_id: `s${i}`, biz_type: "consume", points: -1 })
  items.push({ bill_id: "g1", biz_type: "daily_grant", points: 300, expire_at: "2029-10-24T23:59:59+08:00" })
  items.push({ bill_id: "g2", biz_type: "reward_grant", points: 3000 })
  items.push({ bill_id: "g3", biz_type: "reward_grant", points: 3000 })
  const asked = []
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 5100 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": (req, u) => {
      // offset is ignored and total is always 0, as plugins #223 found
      const limit = Number(u.searchParams.get("paging.limit"))
      asked.push(limit)
      return Response.json({ code: 0, data: { items: items.slice(0, limit), paging: { offset: 0, limit, total: 0 } } })
    },
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({ type: "oauth", access: validTok, refresh: "rt1", expires: Date.now() + 3600_000 }))
  expect(u.balance).toBeUndefined()
  expect(u.windows[0]).toMatchObject({ name: "Credits", amount: 1200, limit: 6300, display: "1200 / 6300" })
  expect(asked).toEqual([1000, 5000])
})

test("checkin preserves renewed tokens, claims once, and returns done on second call", async () => {
  const staleTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) - 5 })
  const freshTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const today = _internal.beijingTodayKey()
  const billItems = []

  startServer({
    "POST /api/web/auth/v1/refresh": () =>
      Response.json({ code: 0, data: { access_token: freshTok, refresh_token: "C2" } }),
    "GET /api/web/office/v3/setting_info": () => {
      if (!billItems.some((b) => b.bill_id === "daily-1")) {
        billItems.push({
          bill_id: "daily-1",
          biz_type: "daily_grant",
          event_name: "每日积分发放",
          points: 300,
          created_at: `${today}T08:00:00+08:00`,
        })
      }
      return Response.json({ code: 0, data: {} })
    },
    "POST /api/web/desktop/v1/login/points/grant": () =>
      Response.json({ code: 0, data: { granted: false } }),
    "GET /api/web/points/v1/bills": () =>
      Response.json({ code: 0, data: { items: billItems } }),
  })

  const saves = []
  let stored = {
    type: "oauth",
    access: staleTok,
    refresh: "C1",
    expires: Date.now() - 5000,
  }
  const client = {
    auth: {
      set: async ({ body }) => {
        saves.push(body)
        stored = body
      },
    },
  }
  const hooks = await RaccoonAuthPlugin({ client })

  const r1 = await hooks.auth.checkin(async () => stored)
  expect(r1).toMatchObject({ outcome: "claimed", credit: 300 })
  expect(saves.at(-1).access).toBe(freshTok)
  expect(saves.at(-1).refresh).toBe("C2")
  expect(saves.at(-1).onboardingSettled).toBe(true)

  const r2 = await hooks.auth.checkin(async () => stored)
  expect(r2).toMatchObject({ outcome: "done" })
})

test("checkin returns failed instead of throwing when upstream errors", async () => {
  const validTok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/office/v3/setting_info": () => new Response("unauthorized", { status: 401 }),
    "GET /api/web/points/v1/bills": () => new Response("unauthorized", { status: 401 }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const r = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "",
    expires: Date.now() + 3600_000,
    onboardingSettled: true,
  }))
  expect(r.outcome).toBe("failed")
})

test("60s renewed cache persists tokens via save without calling /refresh twice", async () => {
  const staleTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) - 5 })
  const freshTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  let refreshCount = 0

  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCount += 1
      return Response.json({ code: 0, data: { access_token: freshTok, refresh_token: `RT-${refreshCount}` } })
    },
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 300 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })

  const savesA = []
  const hooksA = await RaccoonAuthPlugin({
    client: { auth: { set: async ({ body }) => savesA.push(body) } },
  })
  const initialAuth = { type: "oauth", access: staleTok, refresh: "RT-0", expires: Date.now() - 5000 }

  // First path renews RT-0 -> RT-1
  const u1 = await hooksA.auth.usage(async () => initialAuth)
  expect(u1.signIn).toBe("renewed")
  expect(refreshCount).toBe(1)
  expect(savesA.at(-1)?.refresh).toBe("RT-1")

  // Second path (e.g. auth.refresh or another caller still holding RT-0 within 60s)
  // must reuse the cached renewal, persist it, and NOT call /refresh a second time.
  const savesB = []
  const hooksB = await RaccoonAuthPlugin({
    client: { auth: { set: async ({ body }) => savesB.push(body) } },
  })
  const refreshed = await hooksB.auth.refresh(initialAuth)
  expect(refreshCount).toBe(1)
  expect(refreshed?.access).toBe(freshTok)
  expect(refreshed?.refresh).toBe("RT-1")
  expect(savesB.at(-1)?.refresh).toBe("RT-1")
})

// A refresh token that answers for another account is the credential having
// moved, not this seat's renewal: taking it would bill this seat to someone
// else and show that account's credits (plugins #166). The old credential
// stays exactly as it was — the seat is not marked expired either, because a
// later attempt can still answer its own account.
test("a renewal that answers another account does not overwrite the seat's credential", async () => {
  const staleTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) - 5 })
  const otherTok = fakeJwt({ iss: "74350c", name: "AccountB", exp: Math.floor(Date.now() / 1000) + 3600 })
  let refreshCalls = 0
  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCalls += 1
      return Response.json({ code: 0, data: { access_token: otherTok, refresh_token: "X2" } })
    },
  })

  const saves = []
  const hooks = await RaccoonAuthPlugin({ client: { auth: { set: async ({ body }) => saves.push(body) } } })
  const seat = {
    type: "oauth",
    access: staleTok,
    refresh: "X1",
    expires: Date.now() - 5000,
    uid: "7615755",
  }

  let err = null
  try {
    await hooks.auth.refresh(seat)
  } catch (e) {
    err = e
  }
  expect(refreshCalls).toBe(1)
  expect(err?.message).toContain("不同账号")
  expect(err?.signIn).toBe("kept")
  expect(saves).toEqual([])
})

test("loader refreshes on 401, strips x-api-key, rewrites split SSE stream, and passes 402 through", async () => {
  const tok1 = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const tok2 = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 7200 })
  const seenHeaders = []
  let chatCalls = 0

  startServer({
    "POST /api/web/auth/v1/refresh": () =>
      Response.json({ code: 0, data: { access_token: tok2, refresh_token: "R2" } }),
    "POST /api/web/llm/v2/chat/completions": async (req) => {
      chatCalls += 1
      seenHeaders.push({
        auth: req.headers.get("authorization"),
        apiKey: req.headers.get("x-api-key"),
      })
      if (chatCalls === 1) {
        return Response.json({ code: 200003, message: "authorization_verify_error" }, { status: 401 })
      }
      if (chatCalls === 2) {
        const enc = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('data: {"id":"1","model":"internal-m"'))
            controller.enqueue(enc.encode(',"choices":[{"delta":{"content":"ok"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'))
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
      return Response.json({ error: { message: "insufficient quota" } }, { status: 402 })
    },
  })

  let stored = { type: "oauth", access: tok1, refresh: "R1", expires: Date.now() + 3600_000 }
  const hooks = await RaccoonAuthPlugin({
    client: {
      auth: {
        set: async ({ body }) => {
          stored = body
        },
      },
    },
  })
  const loaded = await hooks.auth.loader(async () => stored)

  const res = await loaded.fetch(`${ loaded.baseURL }/chat/completions`, {
    method: "POST",
    headers: { "x-api-key": "should-be-dropped", "content-type": "application/json" },
    body: JSON.stringify({ model: "sn-kimi-k3", messages: [{ role: "user", content: "hi" }], stream: true }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get("x-magpie-sign-in")).toBe("renewed")
  expect(seenHeaders[0]).toEqual({ auth: `Bearer ${tok1}`, apiKey: null })
  expect(seenHeaders[1]).toEqual({ auth: `Bearer ${tok2}`, apiKey: null })
  const text = await res.text()
  expect(text).toContain('"model":"sn-kimi-k3"')
  expect(text).toContain("data: [DONE]")

  const res402 = await loaded.fetch(`${ loaded.baseURL }/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "sn-kimi-k3", messages: [] }),
  })
  expect(res402.status).toBe(402)
  expect(res402.headers.get("x-magpie-sign-in")).toBe("kept")
})

test("the vendor is asked with the SDK's User-Agent, over the one magpie sends", async () => {
  // magpie sends `magpie/<version>` on every request a plugin's fetch makes,
  // and a plugin can't unset it from the provider's side (a plugin's provider
  // has an Account, so provider.PassesUserAgent is false, and its
  // Account.sign is a no-op, so a `user-agent=agent` or a header can't reach
  // it). So the plugin puts its own on here, as the desktop app does.
  const tok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const seen = []
  startServer({
    "POST /api/web/llm/v2/chat/completions": (req) => {
      seen.push({
        ua: req.headers.get("user-agent"),
        accept: req.headers.get("accept"),
        contentType: req.headers.get("content-type"),
      })
      return Response.json({ id: "1", model: "sn-kimi-k3", choices: [{ message: { role: "assistant", content: "ok" } }] })
    },
  })

  const stored = { type: "oauth", access: tok, refresh: "R1", expires: Date.now() + 3600_000 }
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const loaded = await hooks.auth.loader(async () => stored)
  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: "POST",
    // what magpie's pluginFetch hands in: lowercased headers, magpie's own UA
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "magpie/dev",
      "x-api-key": "raccoon",
    },
    body: JSON.stringify({ model: "sn-kimi-k3", messages: [{ role: "user", content: "hi" }] }),
  })

  expect(res.status).toBe(200)
  expect(seen[0].ua).toBe("AsyncOpenAI/Python 2.8.0")
  // and the three it always sets still win over what magpie sent
  expect(seen[0].accept).toBe("*/*")
  expect(seen[0].contentType).toBe("application/json")
})

test("RACCOON_USER_AGENT overrides the User-Agent the vendor is asked with", async () => {
  const tok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const seen = []
  startServer({
    "POST /api/web/llm/v2/chat/completions": (req) => {
      seen.push(req.headers.get("user-agent"))
      return Response.json({ id: "1", model: "sn-kimi-k3", choices: [] })
    },
  })
  const stored = { type: "oauth", access: tok, refresh: "R1", expires: Date.now() + 3600_000 }
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const loaded = await hooks.auth.loader(async () => stored)
  const ask = () =>
    loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "user-agent": "magpie/dev" },
      body: JSON.stringify({ model: "sn-kimi-k3", messages: [] }),
    })

  try {
    expect(_internal.userAgent()).toBe("AsyncOpenAI/Python 2.8.0")
    process.env.RACCOON_USER_AGENT = "MyClient/9.9"
    expect(_internal.userAgent()).toBe("MyClient/9.9")
    await ask()
    expect(seen[0]).toBe("MyClient/9.9")
    // "" hands the request back to magpie's own User-Agent, for a vendor that
    // wants the magpie one
    process.env.RACCOON_USER_AGENT = ""
    expect(_internal.userAgent()).toBe("")
    await ask()
    expect(seen[1]).toBe("magpie/dev")
  } finally {
    delete process.env.RACCOON_USER_AGENT
  }
})

test("desktop sign-in marks expired when desktop app switches to another account", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const otherUserTok = fakeJwt({ iss: "888888", name: "OtherUser", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: otherUserTok, refresh_token: "D1" }))

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const u = await hooks.auth.usage(async () => ({
    type: "oauth",
    source: "desktop",
    uid: "7615755",
    accountId: "RaccoonMason",
  }))
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("切换为其他账号")
})

// The desktop app is signed in to one account at a time: a seat added for the
// first account must keep its own token after the app switched to the second,
// instead of being expired or answered with the second account's token
// (plugins #166: the seat was billed to the wrong account, silently).
test("a desktop seat keeps its own account after the app switches to another", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const aTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) + 3600 })
  const bTok = fakeJwt({ iss: "888888", name: "AccountB", exp: Math.floor(Date.now() / 1000) + 3600 })
  const seen = []
  writeFileSync(authFile, JSON.stringify({ access_token: aTok, refresh_token: "D1" }))

  const hooks = await RaccoonAuthPlugin({ client: {} })
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 300 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
    "POST /api/web/llm/v2/chat/completions": (req) => {
      seen.push(req.headers.get("authorization"))
      return Response.json({ code: 0, data: {} })
    },
  })
  const seatA = await (await hooks.auth.methods[1].authorize()).callback()
  expect(seatA).toMatchObject({ type: "success", source: "desktop", uid: "7615755", accountId: "AccountA" })
  expect(seatA.access).toBe(aTok) // the seat's own record, not "" as before

  // the app signs in to the second account: auth.json is overwritten
  writeFileSync(authFile, JSON.stringify({ access_token: bTok, refresh_token: "D2" }))
  let stored = seatA
  const client = { auth: { set: async ({ body }) => { stored = body } } }
  const hooks2 = await RaccoonAuthPlugin({ client })
  const u = await hooks2.auth.usage(async () => ({ ...stored, type: "oauth" }))
  expect(u.signIn).toBe("kept")
  expect(u.user).toBe("AccountA")
  expect(u.balance).toBe("300 credits")

  // and its own token is spent on requests, not the app's current one
  const loaded = await hooks2.auth.loader(async () => ({ ...stored, type: "oauth" }))
  await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  expect(seen).toEqual([`Bearer ${aTok}`])
})

// The desktop app signs in to one account at a time, and signing in to the
// second revokes the first account's session on the vendor's side (#166,
// measured on a real pair of accounts): the first seat's token is answered
// 401 / 200003 by the credits and check-in endpoints, and 404 by refresh, its
// exp notwithstanding. The seat must then ask to be signed in again, and must
// never fall back to the account the app holds now.
test("a desktop seat asks to sign in again once the vendor revokes its token", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const aTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) + 3600 })
  const bTok = fakeJwt({ iss: "888888", name: "AccountB", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: aTok, refresh_token: "D1" }))
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const seatA = await (await hooks.auth.methods[1].authorize()).callback()

  // the app signs in to the second account, and the vendor revokes the first
  writeFileSync(authFile, JSON.stringify({ access_token: bTok, refresh_token: "D2" }))
  const seen = []
  startServer({
    // what the vendor answers a revoked token with, on every endpoint
    "GET /api/web/points/v1/balance": () =>
      Response.json({ code: 200003, message: "authorization_verify_error" }, { status: 401 }),
    "GET /api/web/auth/v1/entitlement_info": () =>
      Response.json({ code: 200003, message: "authorization_verify_error" }, { status: 401 }),
    "GET /api/web/points/v1/bills": () =>
      Response.json({ code: 200003, message: "authorization_verify_error" }, { status: 401 }),
    "POST /api/web/llm/v2/chat/completions": (req) => {
      seen.push(req.headers.get("authorization"))
      return Response.json({ code: 200003, message: "authorization_verify_error" }, { status: 401 })
    },
  })

  const u = await hooks.auth.usage(async () => ({ ...seatA, type: "oauth" }))
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("authorization_verify_error")

  const loaded = await hooks.auth.loader(async () => ({ ...seatA, type: "oauth" }))
  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  // the app's account is never spent for this seat
  expect(seen).toEqual([`Bearer ${aTok}`])
})

test("a desktop seat asks to sign in again once its own token expires", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const aTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) + 3600 })
  const bTok = fakeJwt({ iss: "888888", name: "AccountB", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: aTok, refresh_token: "D1" }))
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const seatA = await (await hooks.auth.methods[1].authorize()).callback()

  // the app switched, and the seat's own token has since ended
  writeFileSync(authFile, JSON.stringify({ access_token: bTok, refresh_token: "D2" }))
  const u = await hooks.auth.usage(async () => ({ ...seatA, type: "oauth", access: aTok, expires: Date.now() - 60_000 }))
  expect(u.signIn).toBe("expired")
  expect(u.error).toContain("切换为其他账号")
})

test("a uid-less desktop seat takes the app's newer token for the same account (review #486, 2)", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const noUid = fakeJwt({ name: "NoUid", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: noUid, refresh_token: "D1" }))
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const seat = await (await hooks.auth.methods[1].authorize()).callback()
  expect(seat.uid).toBe("")
  // the same account (same name); the app now holds a newer token
  const newer = fakeJwt({ name: "NoUid", exp: Math.floor(Date.now() / 1000) + 7200 })
  writeFileSync(authFile, JSON.stringify({ access_token: newer, refresh_token: "D2" }))
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 321 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const u = await hooks.auth.usage(async () => ({ ...seat, type: "oauth" }))
  expect(u.signIn).toBe("kept")
  expect(u.balance).toBe("321 credits")
})

test("a desktop seat never takes the app's account when its own uid is unknown", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  // a token whose uid cannot be read: the seat names no account it can prove
  const noUid = fakeJwt({ name: "NoUid", exp: Math.floor(Date.now() / 1000) + 3600 })
  const otherTok = fakeJwt({ iss: "888888", name: "OtherUser", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: noUid, refresh_token: "D1" }))
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const seat = await (await hooks.auth.methods[1].authorize()).callback()
  expect(seat.uid).toBe("")

  writeFileSync(authFile, JSON.stringify({ access_token: otherTok, refresh_token: "D2" }))
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 123 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const u = await hooks.auth.usage(async () => ({ ...seat, type: "oauth" }))
  expect(u.signIn).toBe("kept")
  expect(u.user).toBe("NoUid")
  expect(u.balance).toBe("123 credits")
})

// The seat names an account (its uid), and the app now holds a token whose uid
// cannot be read at all. That token is not the seat's account: the seat keeps
// its own, rather than being answered with credentials it cannot be shown to
// own (plugins #166, the "kept / user=B with B's Bearer" case).
test("a desktop seat with a uid is not handed a uid-less app token", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const aTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) + 3600 })
  // the app signed in to an account whose token carries no readable uid
  const noUidTok = fakeJwt({ name: "AccountB", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: aTok, refresh_token: "D1" }))
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const seat = await (await hooks.auth.methods[1].authorize()).callback()
  expect(seat.uid).toBe("7615755")

  writeFileSync(authFile, JSON.stringify({ access_token: noUidTok, refresh_token: "D2" }))
  const seen = []
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 77 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
    "POST /api/web/llm/v2/chat/completions": (req) => {
      seen.push(req.headers.get("authorization"))
      return Response.json({ code: 0, data: {} })
    },
  })
  const u = await hooks.auth.usage(async () => ({ ...seat, type: "oauth" }))
  expect(u.signIn).toBe("kept")
  expect(u.user).toBe("AccountA")
  expect(u.balance).toBe("77 credits")

  const loaded = await hooks.auth.loader(async () => ({ ...seat, type: "oauth" }))
  await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  expect(seen).toEqual([`Bearer ${aTok}`]) // the app's token is never spent
})

test("a desktop seat takes the app's newer token for its own account", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const oldTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) + 3600 })
  const newTok = fakeJwt({ iss: "74350b", name: "AccountA", exp: Math.floor(Date.now() / 1000) + 7200 })
  writeFileSync(authFile, JSON.stringify({ access_token: oldTok, refresh_token: "D1" }))
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const seat = await (await hooks.auth.methods[1].authorize()).callback()

  // the app refreshed its own token while the seat was idle: same account,
  // newer token, and the seat's record is updated to it
  writeFileSync(authFile, JSON.stringify({ access_token: newTok, refresh_token: "D1" }))
  const saves = []
  const client = { auth: { set: async ({ body }) => { saves.push(body) } } }
  const hooks2 = await RaccoonAuthPlugin({ client })
  const seen = []
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 42 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
    "POST /api/web/llm/v2/chat/completions": (req) => {
      seen.push(req.headers.get("authorization"))
      return Response.json({ code: 0, data: {} })
    },
  })
  const loaded = await hooks2.auth.loader(async () => ({ ...seat, type: "oauth" }))
  await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: "POST", body: "{}" })
  expect(seen).toEqual([`Bearer ${newTok}`])
  expect(saves.at(-1)).toMatchObject({ access: newTok, source: "desktop" })
})
test("renewToken cache hit inside 60s invokes save with merged tokens", async () => {
  const staleTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) - 5 })
  const freshTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  let refreshCalls = 0

  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCalls += 1
      return Response.json({ code: 0, data: { access_token: freshTok, refresh_token: "RT-NEW" } })
    },
  })

  const saves1 = []
  const a1 = { access: staleTok, refresh: "RT-COMMON", expires: Date.now() - 5000 }
  const r1 = await _internal.renewToken(a1, async (s) => saves1.push(s))
  expect(refreshCalls).toBe(1)
  expect(saves1.length).toBe(1)
  expect(r1.refresh).toBe("RT-NEW")

  const saves2 = []
  const a2 = { access: staleTok, refresh: "RT-COMMON", expires: Date.now() - 5000, extra: "preserved" }
  const r2 = await _internal.renewToken(a2, async (s) => saves2.push(s))
  expect(refreshCalls).toBe(1)
  expect(saves2.length).toBe(1)
  expect(saves2[0]).toMatchObject({ access: freshTok, refresh: "RT-NEW", extra: "preserved" })
  expect(r2).toMatchObject({ access: freshTok, refresh: "RT-NEW", extra: "preserved" })
})

test("checkin returns done instead of claimed when before-snapshot bills fail", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const today = _internal.beijingTodayKey()
  let billCalls = 0

  startServer({
    "GET /api/web/office/v3/setting_info": () =>
      Response.json({
        code: 0,
        data: { point_grant_popups: { points: 300 } },
      }),
    "GET /api/web/points/v1/bills": () => {
      billCalls += 1
      if (billCalls === 1) {
        // First snapshot fails
        return new Response("gateway timeout", { status: 504 })
      }
      return Response.json({
        code: 0,
        data: {
          items: [
            { bill_id: "b1", biz_type: "daily_grant", points: 300, created_at: `${today}T08:00:00+08:00` },
          ],
        },
      })
    },
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const res = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "",
    expires: Date.now() + 3600_000,
    onboardingSettled: true,
  }))
  expect(res.outcome).toBe("done")
})

test("billKey does not depend on list index when new bills are prepended", () => {
  const itemOld = { created_at: "2026-10-12T08:00:00+08:00", points: 300, event_name: "每日积分发放" }
  const key1 = _internal.billKey(itemOld)
  const itemNew = { created_at: "2026-10-12T09:00:00+08:00", points: 100, event_name: "补充积分" }
  const key2 = _internal.billKey(itemOld)
  expect(key1).toBe(key2)
  expect(_internal.billKey(itemNew)).not.toBe(key1)
})

test("desktop checkin requests onboarding grant only once across runs", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  const authFile = join(tempDir, "auth.json")
  const deskTok = fakeJwt({ iss: "74350b", name: "DeskUser", exp: Math.floor(Date.now() / 1000) + 3600 })
  writeFileSync(authFile, JSON.stringify({ access_token: deskTok, refresh_token: "D1" }))
  _internal.desktopOnboardingSettled.clear()

  let grantCalls = 0
  startServer({
    "POST /api/web/desktop/v1/login/points/grant": () => {
      grantCalls += 1
      return Response.json({ code: 0, data: { granted: false } })
    },
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const authInput = { type: "oauth", source: "desktop", uid: "7615755" }

  await hooks.auth.checkin(async () => authInput)
  expect(grantCalls).toBe(1)

  await hooks.auth.checkin(async () => authInput)
  expect(grantCalls).toBe(1) // Second call must NOT POST onboarding grant again
})

test("failed onboarding grant (500) is not marked settled and retries on next checkin", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  _internal.desktopOnboardingSettled.clear()
  let grantCalls = 0

  startServer({
    "POST /api/web/desktop/v1/login/points/grant": () => {
      grantCalls += 1
      if (grantCalls === 1) {
        return new Response("internal server error", { status: 500 })
      }
      if (grantCalls === 2) {
        return Response.json({ code: 0, data: {} })
      }
      return Response.json({ code: 0, data: { granted: true, popup: { points: 3000 } } })
    },
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })

  // 1. Browser sign-in: 500 on first try must NOT save onboardingSettled: true
  const saves = []
  let browserStored = { type: "oauth", access: validTok, refresh: "R1", expires: Date.now() + 3600_000 }
  const hooks = await RaccoonAuthPlugin({
    client: {
      auth: {
        set: async ({ body }) => {
          saves.push(body)
          browserStored = body
        },
      },
    },
  })

  const r1 = await hooks.auth.checkin(async () => browserStored)
  expect(r1.outcome).toBe("done")
  expect(grantCalls).toBe(1)
  expect(saves.length).toBe(0)
  expect(browserStored.onboardingSettled).toBeUndefined()

  // 2. Desktop sign-in: 500 on try #2 must NOT add to desktopOnboardingSettled
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  writeFileSync(join(tempDir, "auth.json"), JSON.stringify({ access_token: validTok, refresh_token: "D1" }))
  const deskAuth = { type: "oauth", source: "desktop", uid: "7615755", access: validTok, expires: Date.now() + 3600_000 }

  const r2 = await hooks.auth.checkin(async () => deskAuth)
  expect(r2.outcome).toBe("done")
  expect(grantCalls).toBe(2)
  expect(_internal.desktopOnboardingSettled.has("7615755")).toBe(false)

  // 3. Next browser checkin succeeds (200 granted: true) -> claims +3000 and saves onboardingSettled: true
  const r3 = await hooks.auth.checkin(async () => browserStored)
  expect(r3).toMatchObject({ outcome: "claimed", credit: 3000 })
  expect(grantCalls).toBe(3)
  expect(browserStored.onboardingSettled).toBe(true)

  // 4. Next desktop checkin succeeds -> claims +3000 and marks desktopOnboardingSettled
  const r4 = await hooks.auth.checkin(async () => deskAuth)
  expect(r4).toMatchObject({ outcome: "claimed", credit: 3000 })
  expect(grantCalls).toBe(4)
  expect(_internal.desktopOnboardingSettled.has("7615755")).toBe(true)
})

test("checkin reports claimed onboarding grant when before-snapshot fails, and sums daily + onboarding without double-counting", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const today = _internal.beijingTodayKey()
  let scenario = "snapshot-fails"
  let billCallInScenario = 0

  startServer({
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
    "POST /api/web/desktop/v1/login/points/grant": () =>
      Response.json({ code: 0, data: { granted: true, popup: { points: 3000 } } }),
    "GET /api/web/points/v1/bills": () => {
      billCallInScenario += 1
      if (scenario === "snapshot-fails") {
        return new Response("bad gateway", { status: 502 })
      }
      if (billCallInScenario === 1) {
        return Response.json({ code: 0, data: { items: [] } })
      }
      if (scenario === "both-land-no-reward-bill") {
        return Response.json({
          code: 0,
          data: {
            items: [
              { bill_id: "d1", biz_type: "daily_grant", event_name: "每日积分发放", points: 300, created_at: `${today}T08:00:00+08:00` },
            ],
          },
        })
      }
      return Response.json({
        code: 0,
        data: {
          items: [
            { bill_id: "d1", biz_type: "daily_grant", event_name: "每日积分发放", points: 300, created_at: `${today}T08:00:00+08:00` },
            { bill_id: "r1", biz_type: "reward_grant", event_name: "新人礼", points: 3000, created_at: `${today}T08:00:01+08:00` },
          ],
        },
      })
    },
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })

  // Sub-case 1: before-snapshot fails, but onboarding grant succeeded (+3000)
  const res1 = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
  }))
  expect(res1).toMatchObject({ outcome: "claimed", credit: 3000 })

  // Sub-case 2: both daily (+300) and onboarding (+3000) land, and bills only has daily_grant -> sum is 3300
  scenario = "both-land-no-reward-bill"
  billCallInScenario = 0
  const res2 = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
  }))
  expect(res2).toMatchObject({ outcome: "claimed", credit: 3300 })

  // Sub-case 3: bills already includes the new reward_grant (+3000) -> no double count (still 3300)
  scenario = "both-land-with-reward-bill"
  billCallInScenario = 0
  const res3 = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
  }))
  expect(res3).toMatchObject({ outcome: "claimed", credit: 3300 })
})

// The bills list is written behind the grant, so the day it lags the popup is
// the only sign the grant fired. Reporting "done" on that answer said a paid
// day was unpaid (Buddy reads the same two flags for the same reason,
// providers/xiaohuanxiong/quota.py:181-214). It is counted once a day: the
// flag stays in the answer, and a second call that day must not pay it twice.
test("setting_info popup without a new bill reports claimed, once per day", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/office/v3/setting_info": () =>
      Response.json({
        code: 0,
        data: {
          point_grant_popups: { points: 300 },
          point_grant_toast: { points: 300 },
        },
      }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const authObj = {
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
    onboardingSettled: true,
  }
  const res = await hooks.auth.checkin(async () => authObj)
  expect(res).toMatchObject({ outcome: "claimed", credit: 300 })

  // same day, same account: the flag is still there but already counted
  const again = await hooks.auth.checkin(async () => authObj)
  expect(again.outcome).toBe("done")
})

test("a bill that lands after the trigger wins over the popup, and the popup is not added to it", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const today = _internal.beijingTodayKey()
  const billItems = []
  startServer({
    "GET /api/web/office/v3/setting_info": () => {
      if (!billItems.length) {
        billItems.push({
          bill_id: "daily-1",
          biz_type: "daily_grant",
          event_name: "每日积分发放",
          points: 300,
          created_at: `${today}T08:00:00+08:00`,
        })
      }
      return Response.json({ code: 0, data: { point_grant_popups: { points: 300 } } })
    },
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: billItems } }),
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const res = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
    onboardingSettled: true,
  }))
  expect(res).toMatchObject({ outcome: "claimed", credit: 300 })
})

test("the check-in rechecks the bills when the first read shows nothing new", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const today = _internal.beijingTodayKey()
  let reads = 0
  startServer({
    // popup absent: the only evidence is the bill, which lands a read late
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => {
      reads += 1
      // 1 = before-snapshot, 2 = first recheck (empty), 3 = recheck
      const items =
        reads >= 3
          ? [
              {
                bill_id: "daily-1",
                biz_type: "daily_grant",
                event_name: "每日积分发放",
                points: 300,
                created_at: `${today}T08:00:00+08:00`,
              },
            ]
          : []
      return Response.json({ code: 0, data: { items } })
    },
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const res = await hooks.auth.checkin(async () => ({
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
    onboardingSettled: true,
  }))
  expect(res).toMatchObject({ outcome: "claimed", credit: 300 })
  expect(reads).toBeGreaterThanOrEqual(3)
})

test("two check-ins for the same account at once claim the grant once", async () => {
  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  let grantCalls = 0
  let settingCalls = 0
  startServer({
    "POST /api/web/desktop/v1/login/points/grant": () => {
      grantCalls += 1
      return Response.json({ code: 0, data: { granted: true, popup: { points: 3000 } } })
    },
    "GET /api/web/office/v3/setting_info": () => {
      settingCalls += 1
      return Response.json({ code: 0, data: {} })
    },
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })

  const hooks = await RaccoonAuthPlugin({ client: {} })
  const authObj = {
    type: "oauth",
    access: validTok,
    refresh: "R1",
    expires: Date.now() + 3600_000,
  }
  // the host can deliver one user action twice: a body-cap refit, a token-field
  // retry and any 404 are all re-sends (internal/gateway/fallback.go:1766)
  const [a, b] = await Promise.all([hooks.auth.checkin(async () => authObj), hooks.auth.checkin(async () => authObj)])
  expect(settingCalls).toBe(1)
  expect(grantCalls).toBe(1)
  expect(a).toEqual(b)
})

test("X-Client-Platform header derives desktop-mac on darwin and desktop-windows otherwise", async () => {
  expect(_internal.desktopPlatform("darwin")).toBe("desktop-mac")
  expect(_internal.desktopPlatform("win32")).toBe("desktop-windows")
  expect(_internal.desktopPlatform("linux")).toBe("desktop-windows")

  const validTok = fakeJwt({ iss: "74350b", name: "Mason", exp: Math.floor(Date.now() / 1000) + 3600 })
  const seenPlatforms = []
  startServer({
    "GET /api/web/office/v3/setting_info": (req) => {
      seenPlatforms.push(req.headers.get("x-client-platform"))
      return Response.json({ code: 0, data: {} })
    },
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })

  const origDesc = Object.getOwnPropertyDescriptor(process, "platform")
  try {
    const hooks = await RaccoonAuthPlugin({ client: {} })
    const authObj = { type: "oauth", access: validTok, refresh: "R1", expires: Date.now() + 3600_000, onboardingSettled: true }

    Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
    await hooks.auth.checkin(async () => authObj)

    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    await hooks.auth.checkin(async () => authObj)

    expect(seenPlatforms).toEqual(["desktop-mac", "desktop-windows"])
  } finally {
    if (origDesc) Object.defineProperty(process, "platform", origDesc)
  }
})

test("a 0.1.4-style record keeps its accountId on renewal and shows the phone (review #486, 3)", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "raccoon-test-"))
  process.env.RACCOON_BOX_AGENT_CONFIG_DIR = tempDir
  startServer({
    "POST /api/web/auth/v1/refresh": () =>
      Response.json({ code: 0, data: { access_token: "new-tok", refresh_token: "rt-new", expires_in: 86400 } }),
    "/api/web/auth/v1/user_info": () => Response.json({ code: 0, data: { phone: "13800138000", name: "RaccoonBenjamin" } }),
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 100 } }),
    "GET /api/web/auth/v1/entitlement_info": () => Response.json({ code: 0, data: {} }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const old = {
    type: "oauth",
    access: "old-tok",
    refresh: "rt-old",
    expires: Date.now() + 1_000,
    accountId: "Raccoon-pu-abc123",
    uid: "7615755",
  }
  const renewed = await hooks.auth.refresh(old)
  // the identity does not move: a renewal gives no accountId
  expect(renewed.accountId).toBeUndefined()
  expect(renewed.cardName).toBe("138****8000")
  const u = await hooks.auth.usage(async () => ({ ...old, ...renewed, access: "new-tok", expires: Date.now() + 86_400_000 }))
  expect(u.user).toBe("138****8000")
})

test("a desktop seat's refresh gives nothing, even when user_info answers a phone (review #486, 2)", async () => {
  startServer({
    "/api/web/auth/v1/user_info": () => Response.json({ code: 0, data: { phone: "13800138000" } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const got = await hooks.auth.refresh({
    type: "oauth",
    source: "desktop",
    access: "tok-desktop",
    refresh: "D1",
    expires: Date.now() + 1_000,
  })
  expect(got).toBeUndefined()
})

// ---- How often the vendor's non-chat endpoints are read ----------------------
// magpie asks for an account's allowance on clocks of its own (routing once a
// minute while chat flows, the tray every few minutes, the Usage page while it
// is open) and hands the hook no sign of which one asked. These tests hold the
// plugin to what it can do about that: answer from a young reading, keep a
// failure for a moment, and tell magpie when its check-in stops being true.

function countingServer() {
  const hits = { balance: 0, entitlement: 0, bills: 0 }
  startServer({
    "GET /api/web/points/v1/balance": () => {
      hits.balance += 1
      return Response.json({ code: 0, data: { available_points: 300 } })
    },
    "GET /api/web/auth/v1/entitlement_info": () => {
      hits.entitlement += 1
      return Response.json({ code: 0, data: { office: { pro_enable: true, plan_type: "Pro" } } })
    },
    "GET /api/web/points/v1/bills": () => {
      hits.bills += 1
      return Response.json({ code: 0, data: { items: [] } })
    },
  })
  return hits
}

const authRecord = (access) => ({
  type: "oauth",
  access,
  refresh: "rt1",
  expires: Date.now() + 3600_000,
  accountId: "Raccoon-7615755",
})

test("usage answers from one reading for RACCOON_USAGE_TTL_MS instead of the vendor", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  const hits = countingServer()
  const hooks = await RaccoonAuthPlugin({ client: {} })

  const first = await hooks.auth.usage(async () => authRecord(tok))
  expect(first.balance).toBe("300 credits")
  expect(hits.balance).toBe(1)

  // magpie's own clocks: routing's allowance refresh, the tray, the open Usage
  // page — a minute apart, all inside the TTL
  const second = await hooks.auth.usage(async () => authRecord(tok))
  const third = await hooks.auth.usage(async () => authRecord(tok))
  expect(second.balance).toBe("300 credits")
  expect(third.balance).toBe("300 credits")
  expect(hits.balance).toBe(1)
  // the plan and the ledger are read on their own, longer clocks still
  expect(hits.entitlement).toBe(1)
  expect(hits.bills).toBe(1)
})

test("a kept reading says kept, so magpie never reads a reissue it did not make", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  countingServer()
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const first = await hooks.auth.usage(async () => authRecord(tok))
  expect(first.signIn).toBe("kept")
  const again = await hooks.auth.usage(async () => authRecord(tok))
  expect(again.signIn).toBe("kept")
  expect(again.user).toBe("Raccoon-7615755")
})

test("RACCOON_USAGE_TTL_MS=0 turns the reading cache off", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  const hits = countingServer()
  process.env.RACCOON_USAGE_TTL_MS = "0"
  const hooks = await RaccoonAuthPlugin({ client: {} })
  await hooks.auth.usage(async () => authRecord(tok))
  await hooks.auth.usage(async () => authRecord(tok))
  expect(hits.balance).toBe(2)
})

test("a renewal between two reads does not buy a second reading", async () => {
  const staleTok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) - 5 })
  const freshTok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  let refreshCalls = 0
  startServer({
    "POST /api/web/auth/v1/refresh": () => {
      refreshCalls += 1
      return Response.json({ code: 0, data: { access_token: freshTok, refresh_token: "RT-1" } })
    },
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 300 } }),
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const first = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: staleTok,
    refresh: "RT-0",
    expires: Date.now() - 5000,
    accountId: "Raccoon-7615755",
  }))
  expect(first.signIn).toBe("renewed")
  // the next call is handed the account as magpie has it — still the old token,
  // because magpie's own record lags a renewal: the account's reading is the
  // same reading, so the vendor is not asked again
  const again = await hooks.auth.usage(async () => ({
    type: "oauth",
    access: staleTok,
    refresh: "RT-0",
    expires: Date.now() - 5000,
    accountId: "Raccoon-7615755",
  }))
  expect(again.balance).toBe("300 credits")
  expect(refreshCalls).toBe(1)
})

test("two calls at once share one read of the vendor", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  const hits = countingServer()
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const [a, b] = await Promise.all([
    hooks.auth.usage(async () => authRecord(tok)),
    hooks.auth.usage(async () => authRecord(tok)),
  ])
  expect(a.balance).toBe("300 credits")
  expect(b.balance).toBe("300 credits")
  expect(hits.balance).toBe(1)
})

test("a failed read is kept for a moment, a lapse is not", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  let calls = 0
  startServer({
    "GET /api/web/points/v1/balance": () => {
      calls += 1
      return new Response("upstream is down", { status: 500 })
    },
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const auth = { type: "oauth", access: tok, refresh: "", accountId: "Raccoon-1" }
  const first = await hooks.auth.usage(async () => auth)
  expect(first.error).toContain("HTTP 500")
  const second = await hooks.auth.usage(async () => auth)
  expect(second.error).toBe(first.error)
  // one read, not two: the second call was answered from the kept failure
  expect(calls).toBe(1)
})

test("a check-in drops the kept reading, so the press shows what it claimed", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  let avail = 300
  let hits = 0
  startServer({
    "GET /api/web/points/v1/balance": () => {
      hits += 1
      return Response.json({ code: 0, data: { available_points: avail } })
    },
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const before = await hooks.auth.usage(async () => authRecord(tok))
  expect(before.balance).toBe("300 credits")
  // the check-in pays 2000: the card the user is looking at must not keep
  // saying 300 for the next three minutes
  avail = 2300
  await hooks.auth.checkin(async () => ({ ...authRecord(tok), onboardingSettled: true }))
  const after = await hooks.auth.usage(async () => authRecord(tok))
  expect(after.balance).toBe("2300 credits")
  expect(hits).toBe(2)
})

test("a balance the cached ledger cannot account for reads the ledger again", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  let granted = 300
  let bills = 0
  startServer({
    "GET /api/web/points/v1/balance": () => Response.json({ code: 0, data: { available_points: 3300 } }),
    "GET /api/web/points/v1/bills": () => {
      bills += 1
      return Response.json({
        code: 0,
        data: { items: [{ bill_id: `g${bills}`, biz_type: "daily_grant", points: granted, expire_at: "2029-10-18T23:59:59+08:00" }] },
      })
    },
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  // the ledger is young but says 300 while the wallet holds 3300: that is a
  // grant the ledger has not caught up with, not a negative `used`
  const first = await hooks.auth.usage(async () => authRecord(tok))
  expect(first.windows[0]?.amount ?? first.balance).toBe("3300 credits")
  expect(bills).toBe(2)
  // and the self-heal is itself held to the bills TTL: a second call inside it
  // does not read the ledger twice more
  await hooks.auth.usage(async () => authRecord(tok))
  expect(bills).toBe(2)
})

test("the check-in says when its answer stops being true", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  startServer({
    "GET /api/web/points/v1/bills": () => Response.json({ code: 0, data: { items: [] } }),
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const r = await hooks.auth.checkin(async () => ({ ...authRecord(tok), onboardingSettled: true }))
  expect(r.outcome).toBe("done")
  // magpie re-asks a "done" every 30 minutes until noon unless the answer names
  // an `until` (internal/provider/checkin.go, workbuddy_checkin.go settled())
  expect(r.until).toBeTruthy()
  const until = Date.parse(r.until)
  expect(Number.isFinite(until)).toBe(true)
  expect(until).toBeGreaterThan(Date.now())
  // the next Beijing midnight, and nothing later than a day away
  expect(until - Date.now()).toBeLessThanOrEqual(24 * 3600_000)
  expect(new Date(until + 8 * 3600_000).toISOString().slice(11, 19)).toBe("00:00:00")
})

test("a claimed check-in carries the same until", async () => {
  const tok = fakeJwt({ iss: "74350b", exp: Math.floor(Date.now() / 1000) + 3600 })
  // the before-snapshot is the first read and has no grant in it; the re-read
  // right after does — a grant that landed between the two calls
  let reads = 0
  startServer({
    "GET /api/web/points/v1/bills": () => {
      reads += 1
      const granted = reads > 1
      return Response.json({
        code: 0,
        data: {
          items: granted
            ? [{ bill_id: "today", biz_type: "daily_grant", points: 300, created_at: _internal.beijingTodayKey() + "T00:00:01" }]
            : [],
        },
      })
    },
    "GET /api/web/office/v3/setting_info": () => Response.json({ code: 0, data: {} }),
  })
  const hooks = await RaccoonAuthPlugin({ client: {} })
  const r = await hooks.auth.checkin(async () => ({ ...authRecord(tok), onboardingSettled: true }))
  expect(r.outcome).toBe("claimed")
  expect(r.until).toBeTruthy()
})

test("nextBeijingMidnight is the vendor's day turning, not ours", async () => {
  // 2026-11-06T10:00:00+08:00
  const at = Date.UTC(2026, 10, 6, 2, 0, 0)
  expect(_internal.nextBeijingMidnight(at)).toBe(Date.UTC(2026, 10, 6, 16, 0, 0))
  // the last second of a Beijing day still points at the next one
  const late = Date.UTC(2026, 10, 6, 15, 59, 59)
  expect(_internal.nextBeijingMidnight(late)).toBe(Date.UTC(2026, 10, 6, 16, 0, 0))
  // and the first second after it points a day further
  const early = Date.UTC(2026, 10, 6, 16, 0, 0)
  expect(_internal.nextBeijingMidnight(early)).toBe(Date.UTC(2026, 10, 7, 16, 0, 0))
})
