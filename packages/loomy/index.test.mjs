import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { LoomyAuthPlugin, _internal } from "./index.mjs"
import { fakeLoomy } from "./fake.mjs"

// every test runs against the fake upstream in fake.mjs: no network, no real
// token ever leaves this process

let fake
let plugin
let saved = {}
const client = { auth: { set: async ({ body }) => (saved = body) } }
const getAuth = async () => saved

beforeAll(async () => {
  fake = fakeLoomy()
  process.env.LOOMY_POINTS_BASE_URL = fake.gatewayUrl
  process.env.LOOMY_XFYUN_BASE_URL = fake.accountUrl
})

afterAll(() => {
  fake.account.stop(true)
  fake.gateway.stop(true)
})

beforeEach(async () => {
  fake.state.reset()
  saved = { type: "oauth", access: fake.state.session, expires: 0, accountId: "138****8000", name: "138****8000", source: "manual" }
  plugin = await LoomyAuthPlugin({ client })
})

describe("sign-in methods", () => {
  test("SMS: sends the code, then trades it for a 14-day session", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const flow = await method.authorize({ phone: "138 0013 8000" }) // spaces tolerated
    expect(flow.method).toBe("code")
    expect(flow.instructions).toContain("已发送")
    expect(fake.state.smsSent).toBeTruthy()
    // wrong code fails with a reason
    expect((await flow.callback("000000")).type).toBe("failed")
    const result = await flow.callback("123456")
    expect(result.type).toBe("success")
    expect(result.access).toBe("sess-1")
    expect(result.expires).toBeGreaterThan(Date.now() + 13 * 86400e3)
    expect(result.accountId).toBe("138****8000")
  })

  test("SMS: an invalid phone is refused before anything is sent", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("SMS"))
    const bad = await method.authorize({ phone: "12345" })
    expect(bad.type).toBe("failed")
    expect(fake.state.smsSent).toBeNull()
  })

  test("manual paste works through the host's authorize → callback contract", async () => {
    const method = plugin.auth.methods.find((m) => m.label.includes("Paste"))
    const flow = await method.authorize({ session: "pasted" })
    expect(flow.method).toBe("auto")
    expect(typeof flow.callback).toBe("function")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe("pasted")
    expect(await method.authorize({ session: "" })).toMatchObject({ type: "failed" })
  })
})

describe("chat", () => {
  test("forwards with the double auth headers and streams through", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/v1/chat/completions`.replace("/v1/v1/", "/api/v1/"), {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"content":"你"')
    expect(text).toContain("data: [DONE]")
    expect(fake.state.chatCalls.length).toBe(1)
    expect(fake.state.chatCalls[0].body.model).toBe("spark-x")
  })

  test("a genuinely over-length Kimi-k2.6 request still comes back 400", async () => {
    // 150 万 ASCII 字符 ≈ 37.5 万 token，对 262,144 窗口的 Kimi-k2.6 是真超长。
    // 旧实现按固定 200 万字符阈值判成「上游瞬时故障」并改成 502，magpie 会换号重试到整轮失败。
    fake.state.chatRefusal = "内容太长了，请精简输入或开启新对话"
    const loader = await plugin.auth.loader(getAuth)
    const huge = "word ".repeat(300_000)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k2.6", stream: false, messages: [{ role: "user", content: huge }] }),
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("上下文超出长度限制")
  })

  test("reasoning effort folds to low/medium/high", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, reasoning_effort: "minimal", messages: [] }),
    })
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, reasoning_effort: "max", messages: [] }),
    })
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, reasoning_effort: "none", messages: [] }),
    })
    expect(fake.state.chatCalls[0].body.reasoning_effort).toBe("low")
    expect(fake.state.chatCalls[1].body.reasoning_effort).toBe("high")
    expect(fake.state.chatCalls[2].body.reasoning_effort).toBeUndefined()
  })

  test("deepseek images become base64 markers merged into the text", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        stream: false,
        messages: [
          { role: "user", content: [
            { type: "text", text: "看这张图" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            { type: "image_url", image_url: { url: "https://example.com/x.png" } },
          ] },
        ],
      }),
    })
    const content = fake.state.chatCalls[0].body.messages[0].content
    expect(content).toHaveLength(2)
    expect(content[0].text).toContain("看这张图")
    expect(content[0].text).toContain("<image_base64>data:image/png;base64,QUJD</image_base64>")
    // an http(s) URL stays as it was (no evidence the marker accepts URLs)
    expect(content[1].type).toBe("image_url")
  })

  test("a refused session says 401", async () => {
    saved = { type: "oauth", access: "gone", expires: 0 }
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
    })
    expect(res.status).toBe(401)
  })

  test("only chat completions and image generations are served", async () => {
    const loader = await plugin.auth.loader(getAuth)
    for (const path of ["/api/v1/embeddings", "/api/v1/images/edits"]) {
      const res = await loader.fetch(`${fake.gatewayUrl}${path}`, { method: "POST", body: "{}" })
      expect(res.status).toBe(404)
    }
    expect(fake.state.imageCalls).toHaveLength(0)
  })
})

describe("images (#609)", () => {
  // the request magpie's gateway writes for a draw (internal/gateway/draw.go
  // drawImages), as the reporter sent it by hand
  const drawBody = JSON.stringify({ model: "doubao-seedream-5-lite", prompt: "a red apple", n: 1, size: "1024x1024" })

  test("a draw goes to /images/generations with the session, asking for JSON", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/images/generations`, { method: "POST", body: drawBody })
    expect(res.status).toBe(200)
    // the reply is the upstream's own JSON, passed through
    expect(await res.text()).toBe('{"created":1793554989,"data":[{"url":"https://aigc-output-image-...png"}],"points_consumed":110}')
    expect(fake.state.imageCalls).toHaveLength(1)
    const call = fake.state.imageCalls[0]
    expect(call.token).toBe(fake.state.session)
    expect(call.bearer).toBe(fake.state.session)
    expect(call.accept).toBe("application/json")
    expect(call.body).toEqual(JSON.parse(drawBody))
    expect(fake.state.chatCalls).toHaveLength(0)
  })

  test("a Request object's body is sent as well", async () => {
    const loader = await plugin.auth.loader(getAuth)
    const req = new Request(`${fake.gatewayUrl}/api/v1/images/generations`, { method: "POST", body: drawBody })
    const res = await loader.fetch(req)
    expect(res.status).toBe(200)
    expect(fake.state.imageCalls[0].body.model).toBe("doubao-seedream-5-lite")
  })

  test("a refused session says 401, as chat does", async () => {
    for (const status of [401, 403]) {
      fake.state.imageStatus = status
      const loader = await plugin.auth.loader(getAuth)
      const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/images/generations`, { method: "POST", body: drawBody })
      expect(res.status).toBe(401)
      expect((await res.json()).error.message).toContain("登录态已失效")
    }
  })

  test("another upstream error keeps its status and says what came back", async () => {
    fake.state.imageStatus = 400
    const loader = await plugin.auth.loader(getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/images/generations`, { method: "POST", body: drawBody })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("refused 400")
  })

  test("a chat still streams after a draw", async () => {
    const loader = await plugin.auth.loader(getAuth)
    await loader.fetch(`${fake.gatewayUrl}/api/v1/images/generations`, { method: "POST", body: drawBody })
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("data: [DONE]")
    expect(fake.state.chatCalls).toHaveLength(1)
    expect(fake.state.imageCalls).toHaveLength(1)
  })
})

describe("checkin", () => {
  test("the day's first call claims the grant, a repeat is done", async () => {
    // the daily wallet moves 3000 → 5000 on the day's first call: claimed
    const result = await plugin.auth.checkin(getAuth)
    expect(result.outcome).toBe("claimed")
    expect(result.credit).toBe(2000)
    expect(result.message).toContain("5000")
    expect(fake.state.firstLoginCalls).toBe(1)
    // the endpoint answers success on a repeat too, but the wallet is flat:
    // done, not a second claim
    const again = await plugin.auth.checkin(getAuth)
    expect(again.outcome).toBe("done")
    expect(again.credit).toBeUndefined()
    expect(fake.state.firstLoginCalls).toBe(2)
  })

  test("a refused session says the sign-in expired", async () => {
    saved = { type: "oauth", access: "gone", expires: 0 }
    await expect(plugin.auth.checkin(getAuth)).rejects.toThrow(/失效/)
  })

  test("a failed pre-read is failed, not silently done", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      // fail only the records read; the first-login POST still goes through
      if (String(url).includes("/api/v2/points/records")) return new Response("boom", { status: 502 })
      return realFetch(input, init)
    }
    try {
      const result = await plugin.auth.checkin(getAuth)
      expect(result.outcome).toBe("failed")
      expect(result.message).toContain("无法读取签到前余额")
      expect(fake.state.firstLoginCalls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("models", () => {
  test("the catalog, with rates split out of the names", async () => {
    const p = { models: {} }
    const list = await plugin.provider.models(p, { auth: saved })
    expect(Object.keys(list)).toEqual(["spark-x", "deepseek-v4-flash", "glm-5.3-flash", "plain"])
    expect(list["spark-x"].rate).toBe("x0.1")
    expect(list["spark-x"].name).toBe("Spark X2.5")
    expect(list["spark-x"].reasoning).toBe(true)
    expect(list["spark-x"].tool_call).toBe(true)
    expect(list["deepseek-v4-flash"].rate).toBe("x3.0")
    expect(list["glm-5.3-flash"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    expect(list["plain"].rate).toBeUndefined()
    expect(list["plain"].name).toBe("No Suffix At All")
  })
})

describe("usage", () => {
  test("the two wallets as windows", async () => {
    const usage = await plugin.auth.usage(getAuth)
    // a clean read says nothing about the sign-in, so magpie can clear a lapse
    expect(usage.signIn).toBeUndefined()
    const daily = usage.windows.find((w) => w.name === "每日赠送积分")
    // the vendor's own numbers: spent = dailyLimitPoints - dailyRemainingPoints
    expect(daily.limit).toBe(5000)
    expect(daily.amount).toBe(5000 - fake.state.dailyBalance)
    // `used` is a share, not a count: an absolute 2000 would read as 2000%,
    // i.e. a spent-out account
    expect(daily.used).toBeCloseTo((100 * (5000 - fake.state.dailyBalance)) / 5000, 5)
    expect(daily.resetsAt).toBeGreaterThan(Date.now())
    // the prepaid wallet holds credits, so it is the window that carries the
    // account and the grant only shows
    expect(daily.aside).toBe(true)
    const permanent = usage.windows.find((w) => w.name === "永久积分")
    expect(permanent.balance).toBe(5000)
    expect(permanent.unit).toBe("credits")
    expect(permanent.aside).toBeUndefined()
  })

  test("one window carries the account, so the Routing page knows the allowance", async () => {
    // magpie weighs an account only by the windows it does not set aside
    // (`allowanceOf`: `if w.Aside || w.Text { continue }`), and an account
    // with none of those reads 剩余额度未知 on the Routing page. Every window
    // needs a reading, and at least one must not be set aside.
    const usage = await plugin.auth.usage(getAuth)
    expect(usage.windows.length).toBeGreaterThan(0)
    for (const w of usage.windows) expect(w.used != null || w.balance != null).toBe(true)
    expect(usage.windows.filter((w) => !w.aside).length).toBe(1)
    // a wallet's `used` must stay undefined: magpie invents no share for one
    const wallet = usage.windows.find((w) => w.name === "永久积分")
    expect(typeof wallet.balance).toBe("number")
    expect(wallet.used).toBeUndefined()
  })

  test("an empty wallet hands the account to the grant", async () => {
    const realFetch = globalThis.fetch
    // magpie reads a balance of 0 as used up, so a wallet with nothing left
    // must not be the one carrying an account the day's grant still pays for
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      if (String(url).includes("/api/v2/points/records"))
        return new Response(JSON.stringify({ code: "000000", desc: "ok", data: { balance: 0, dailyLimitPoints: 5000, dailyRemainingPoints: 5000, list: [], total: 0 } }), { status: 200 })
      return realFetch(input, init)
    }
    try {
      const usage = await plugin.auth.usage(getAuth)
      const daily = usage.windows.find((w) => w.name === "每日赠送积分")
      const permanent = usage.windows.find((w) => w.name === "永久积分")
      expect(daily.aside).toBeUndefined()
      expect(permanent.aside).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a pair of zeros is no reading at all, an error not an empty list", async () => {
    const realFetch = globalThis.fetch
    // a zero limit makes the pair tell no share, and there is no permanent
    // balance either: an empty window list would read as an account magpie
    // cannot weigh, so it says why instead
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      if (String(url).includes("/api/v2/points/records"))
        return new Response(JSON.stringify({ code: "000000", desc: "ok", data: { dailyLimitPoints: 0, dailyRemainingPoints: 0, list: [], total: 0 } }), { status: 200 })
      return realFetch(input, init)
    }
    try {
      const usage = await plugin.auth.usage(getAuth)
      expect(usage.windows).toBeUndefined()
      expect(usage.error).toContain("没有返回余额字段")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a daily wallet without the limit pair is a balance with no limit", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      if (String(url).includes("/api/v2/points/records"))
        return new Response(JSON.stringify({ code: "000000", desc: "ok", data: { balance: 5000, dailyBalance: 3000, list: [], total: 0 } }), { status: 200 })
      return realFetch(input, init)
    }
    try {
      const usage = await plugin.auth.usage(getAuth)
      const daily = usage.windows.find((w) => w.name === "每日赠送积分")
      // no pair means no limit, and a made-up one always reads as full
      expect(daily.limit).toBeUndefined()
      expect(daily.used).toBeUndefined()
      expect(daily.balance).toBe(3000)
      // the prepaid wallet holds credits, so it is the one carrying the
      // account and the grant only shows
      expect(daily.aside).toBe(true)
      // a reply with only the limit/remaining pair still shows the daily
      // wallet (remaining IS its number), without dailyBalance
      globalThis.fetch = (input, init) => {
        const url = typeof input === "string" ? input : String(input?.url ?? input)
        if (String(url).includes("/api/v2/points/records"))
          return new Response(JSON.stringify({ code: "000000", desc: "ok", data: { dailyLimitPoints: 5000, dailyRemainingPoints: 4200, list: [] } }), { status: 200 })
        return realFetch(input, init)
      }
      try {
        const pairOnly = await plugin.auth.usage(getAuth)
        const dw = pairOnly.windows.find((w) => w.name === "每日赠送积分")
        expect(dw).toBeTruthy()
        // spent 800 of 5000: `used` is the share, `amount` the count
        expect(dw.used).toBe(16)
        expect(dw.amount).toBe(800)
        expect(dw.limit).toBe(5000)
        expect(pairOnly.windows.find((w) => w.name === "永久积分")).toBeUndefined()
      } finally {
        globalThis.fetch = realFetch
      }
      // a reply with neither balance field is an error, not a confident zero
      globalThis.fetch = (input, init) => {
        const url = typeof input === "string" ? input : String(input?.url ?? input)
        if (String(url).includes("/api/v2/points/records"))
          return new Response(JSON.stringify({ code: "000000", desc: "ok", data: { records: [] } }), { status: 200 })
        return realFetch(input, init)
      }
      try {
        const missing = await plugin.auth.usage(getAuth)
        expect(missing.error).toContain("没有返回余额字段")
      } finally {
        globalThis.fetch = realFetch
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("signature", () => {
  test("the 9-part HMAC string matches the client's shape", () => {
    const headers = _internal.signHeaders("POST", "/login/phone/sendMsgCode", '{"a":1}')
    expect(headers.Authorization).toMatch(/^account 2thryby66wxi53sk:[A-Za-z0-9+/=]+$/)
    expect(headers.Date).toMatch(/GMT$/)
    expect(headers.Nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers["Content-MD5"]).toBe(_internal.contentMD5('{"a":1}'))
    // no body: no MD5 header, and the empty part sits in the string
    const empty = _internal.signHeaders("GET", "/x", "")
    expect(empty["Content-MD5"]).toBeUndefined()
  })

  test("paths are escaped and trailing slashes dropped", () => {
    expect(_internal.escapedPath("/login/phone/sendMsgCode")).toBe("/login/phone/sendMsgCode")
    expect(_internal.escapedPath("a/b/")).toBe("/a/b")
    expect(_internal.escapedPath("/带中文/段")).toBe(`/${encodeURIComponent("带中文")}/${encodeURIComponent("段")}`)
  })
})

describe("helpers", () => {
  test("phone normalization", () => {
    expect(_internal.normalizePhone("13800138000")).toBe("13800138000")
    expect(_internal.normalizePhone("+86 138-0013-8000")).toBe("13800138000")
    expect(_internal.normalizePhone("8613800138000")).toBe("13800138000")
    expect(_internal.normalizePhone("12345")).toBeNull()
    expect(_internal.normalizePhone("12800138000")).toBeNull() // second digit not 3-9
  })

  test("rate suffix split", () => {
    expect(_internal.splitRateSuffix("DeepSeek V4 Flash 0731 (x3.0)")).toEqual({ name: "DeepSeek V4 Flash 0731", rate: "x3.0" })
    expect(_internal.splitRateSuffix("GLM 5.3 Flash(x0.8)")).toEqual({ name: "GLM 5.3 Flash", rate: "x0.8" })
    expect(_internal.splitRateSuffix("Spark X2.5 （x0.1）")).toEqual({ name: "Spark X2.5", rate: "x0.1" })
    expect(_internal.splitRateSuffix("限时免费")).toEqual({ name: "限时免费", rate: undefined })
    expect(_internal.splitRateSuffix("Model (free)")).toEqual({ name: "Model (free)", rate: undefined })
  })
})

// ── 「内容太长了」的分流 ────────────────────────────────────────────────
//
// 上游这条 400 不含「上下文」：v0.1.2189 之前的 magpie 的 tooLongRe 认不出，
// 这笔 try 就被当成错误、账号被休息、组里其它成员一次没被问，整轮失败。
// 这里只改写文案（状态码不变），让旧宿主也能认成 overflow；
// v0.1.2189 起宿主自己认得，这是给旧宿主的兜底。

describe("a 400 that says the content is too long", () => {
  // magpie `internal/gateway/gateway.go` 的 tooLongRe 中文两条 —— 逐字抄，改这里等于改契约
  const tooLongRe = /上下文(长度)?(超|过长)|超(过|出)(了)?(模型)?(的)?(最大)?上下文/
  const vendor = "内容太长了，请精简输入或开启新对话"

  test("改写成 tooLongRe 认得的说法，状态码保持 400", async () => {
    const out = _internal.retryableRefusal(400, JSON.stringify({ error: { message: vendor } }))
    expect(out).not.toBeNull()
    expect(out.status).toBe(400)
    const body = await out.text()
    expect(body).toMatch(tooLongRe)
    expect(body).not.toContain("内容太长")
  })

  test("413 与 422 同办，状态码不变", async () => {
    for (const status of [413, 422]) {
      const out = _internal.retryableRefusal(status, vendor)
      expect(out.status).toBe(status)
      expect(await out.text()).toMatch(tooLongRe)
    }
  })

  test("别的 400 不碰", () => {
    expect(_internal.retryableRefusal(400, JSON.stringify({ error: { message: "invalid api key" } }))).toBeNull()
  })

  test("不是 400/413/422 的不碰（2xx 是 SSE 干流）", () => {
    expect(_internal.retryableRefusal(200, vendor)).toBeNull()
    expect(_internal.retryableRefusal(429, vendor)).toBeNull()
    expect(_internal.retryableRefusal(500, vendor)).toBeNull()
  })
})

// ── password sign-in and renewal (renew.mjs) ────────────────────────────────
//
// Loomy hands out no refresh token, so the password IS the renewal
// credential. These tests hold three things down: the password is sealed to
// the key getPuKey hands out (never sent as plaintext), it is kept on the
// sign-in record in `refresh`, and a dead session is renewed on both paths —
// the host's auth.refresh and, for OpenCode which never calls it, a 401 on
// the request itself.

describe("password sign-in", () => {
  const passwordMethod = () => plugin.auth.methods.find((m) => m.label.includes("Password"))

  test("getPuKey's key seals the password, then byPwd answers a session", async () => {
    const method = passwordMethod()
    expect(method).toBeTruthy()
    expect(method.type).toBe("oauth")
    // the password prompt is type "password": OpenCode masks what is typed
    expect(method.prompts.find((p) => p.key === "password")?.type).toBe("password")
    const flow = await method.authorize({ loginid: "13800138000", password: "hunter2" })
    // nothing to open — the sign-in is two calls behind the scenes
    expect(flow.method).toBe("auto")
    expect(flow.url).toBe("")
    const result = await flow.callback()
    expect(result.type).toBe("success")
    expect(result.access).toBe(fake.state.session)
    expect(result.source).toBe("password")
    expect(result.accountId).toBe("138****8000")
    expect(result.uid).toBe("261014155255771375")
    expect(result.expires).toBeGreaterThan(Date.now() + 13 * 86400e3)
    // the credentials ride on `refresh` as JSON — that is where magpie keeps
    // an oauth account's secret, and where renewal reads them back from
    expect(JSON.parse(result.refresh)).toEqual({ loginid: "13800138000", password: "hunter2" })
    // and the password really was sealed: the fake decrypted it server-side
    expect(fake.state.pwdKeyCalls).toBe(1)
    expect(fake.state.pwdAttempts[0].password).toBe("hunter2")
    expect(fake.state.pwdAttempts[0].rcode).toBe("rc-1")
    expect(fake.state.pwdAttempts[0].expire).toBe(1209600)
  })

  test("a wrong password is refused with the vendor's reason", async () => {
    const flow = await passwordMethod().authorize({ loginid: "13800138000", password: "nope" })
    const result = await flow.callback()
    expect(result.type).toBe("failed")
    expect(result.error).toContain("账号或密码错误")
  })

  test("an invalid phone never reaches the upstream", async () => {
    const bad = await passwordMethod().authorize({ loginid: "12345", password: "hunter2" })
    // authorize refuses synchronously, so the picker shows the reason at once
    expect(bad.type).toBe("failed")
    expect(fake.state.pwdKeyCalls).toBe(0)
  })

  test("a rotated rcode is refused: the nonce getPuKey handed out is what byPwd wants", async () => {
    const flow = await passwordMethod().authorize({ loginid: "13800138000", password: "hunter2" })
    // the nonce rotates under it, as it would if another sign-in called
    // getPuKey in between — the sealed password is worthless without the
    // rcode that came with its key
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      const res = await realFetch(input, init)
      if (String(url).includes("/login/account/getPuKey")) fake.state.rcode = "rc-99"
      return res
    }
    try {
      const result = await flow.callback()
      expect(result.type).toBe("failed")
      expect(result.error).toContain("rcode")
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("renewal", () => {
  // its own store so saves can be counted: the shared one only keeps the record
  let store
  beforeEach(async () => {
    store = {
      auth: { type: "oauth", access: fake.state.session, expires: Date.now() + 14 * 86400e3, accountId: "138****8000", name: "138****8000" },
      saves: [],
    }
    store.getAuth = async () => store.auth
    store.client = {
      auth: {
        set: async ({ path, body }) => {
          store.saves.push({ id: path.id, body })
          store.auth = body
        },
      },
    }
    store.plugin = await LoomyAuthPlugin({ client: store.client })
  })
  const creds = (over = {}) => ({ ...store.auth, refresh: JSON.stringify({ loginid: "13800138000", password: "hunter2" }), ...over })

  test("refreshLead sits on auth, 3 days before the 14-day session ends", async () => {
    // host.js reads the lead off auth (leadOf), not off the hooks object
    expect(store.plugin.auth.refreshLead).toBe(3 * 86400e3)
    expect(typeof store.plugin.auth.refresh).toBe("function")
  })

  test("a password account signs in again, and only what changed comes back", async () => {
    const out = await store.plugin.auth.refresh(creds())
    expect(out.access).toBe(fake.state.session)
    expect(out.expires).toBeGreaterThan(Date.now() + 13 * 86400e3)
    expect(out.uid).toBe("261014155255771375")
    // `refresh` itself is absent: the host merges this onto the record, and
    // echoing the credentials back would be noise (it only wants changes)
    expect(out.refresh).toBeUndefined()
    // the record it hands back is written through, since this path is not one
    // the host saves for us
    expect(store.saves).toHaveLength(1)
    expect(store.saves[0].id).toBe("loomy")
    expect(store.saves[0].body.access).toBe(fake.state.session)
  })

  test("SMS and pasted sessions carry no password, so there is nothing to renew", async () => {
    // "" is what both of those sign-ins write into `refresh`
    expect(await store.plugin.auth.refresh({ ...store.auth, refresh: "" })).toBeUndefined()
    expect(await store.plugin.auth.refresh({ ...store.auth })).toBeUndefined()
    expect(await store.plugin.auth.refresh({ ...store.auth, type: "api" })).toBeUndefined()
    expect(fake.state.pwdKeyCalls).toBe(0)
  })

  test("a vendor refusal ends the sign-in; a transport failure leaves it alone", async () => {
    // wrong password: HTTP 200 with a business code is the vendor saying no
    await expect(store.plugin.auth.refresh(creds({ refresh: JSON.stringify({ loginid: "13800138000", password: "nope" }) }))).rejects.toMatchObject({
      signIn: "expired",
    })
    // a network failure must NOT mark the account, or a flaky moment would
    // end a sign-in that is still perfectly good
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error("offline")
    }
    try {
      const err = await store.plugin.auth.refresh(creds()).catch((e) => e)
      expect(err?.signIn).toBeUndefined()
      expect(String(err?.message)).toContain("offline")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("a dead session is renewed on the request path (OpenCode never calls refresh)", async () => {
    store.auth = { ...creds(), access: "gone" }
    const loader = await store.plugin.auth.loader(store.getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "spark-x", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("data: [DONE]")
    // the sign-in happened once, and the host was told the session is new
    expect(fake.state.pwdCalls).toBe(1)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
    expect(store.saves).toHaveLength(1)
    expect(store.auth.access).toBe(fake.state.session)
  })

  test("a draw is renewed the same way", async () => {
    store.auth = { ...creds(), access: "gone" }
    const loader = await store.plugin.auth.loader(store.getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/images/generations`, { method: "POST", body: JSON.stringify({ model: "m", prompt: "p" }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("renewed")
    expect(fake.state.pwdCalls).toBe(1)
  })

  test("a pasted session that lapses says so on the header: no password, no rescue", async () => {
    store.auth = { type: "oauth", access: "gone", expires: 0, accountId: "手动粘贴", refresh: "" }
    const loader = await store.plugin.auth.loader(store.getAuth)
    const res = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
    expect((await res.json()).error.message).toContain("登录态已失效")
    // magpie takes the header off before the agent sees the answer, so this is
    // how a session with no password behind it gets marked lapsed
    expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
    expect(fake.state.pwdCalls).toBe(0)
    expect(store.saves).toHaveLength(0)
  })

  test("a password the vendor no longer takes ends the sign-in; a flaky network does not", async () => {
    // wrong password on the renewal: 200 + a business code is the vendor's no
    store.auth = { ...creds({ refresh: JSON.stringify({ loginid: "13800138000", password: "nope" }) }), access: "gone" }
    const loader = await store.plugin.auth.loader(store.getAuth)
    const refused = await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, { method: "POST", body: "{}" })
    expect(refused.status).toBe(401)
    expect(refused.headers.get("X-Magpie-Sign-In")).toBe("expired")

    // a network failure during renewal is not a verdict on the password
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : String(input?.url ?? input)
      if (String(url).includes("/login/account/")) throw new Error("offline")
      return realFetch(input, init)
    }
    try {
      store.auth = { ...creds(), access: "gone" }
      const loader2 = await store.plugin.auth.loader(store.getAuth)
      const flaky = await loader2.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, { method: "POST", body: "{}" })
      expect(flaky.status).toBe(401)
      expect(flaky.headers.get("X-Magpie-Sign-In")).toBe("kept")
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("checkin and usage renew a lapsed session instead of reporting it dead", async () => {
    store.auth = { ...creds(), access: "gone" }
    // checkin throws its lapse, usage returns it: both are caught and retried
    const result = await store.plugin.auth.checkin(store.getAuth)
    expect(result.outcome).toBe("claimed")
    expect(fake.state.pwdCalls).toBe(1)
  })

  test("usage renews a lapsed session too", async () => {
    store.auth = { ...creds(), access: "gone" }
    const usage = await store.plugin.auth.usage(store.getAuth)
    expect(usage.signIn).toBeUndefined()
    expect(usage.windows.map((w) => w.name)).toContain("每日赠送积分")
    expect(fake.state.pwdCalls).toBe(1)
    expect(store.saves).toHaveLength(1)
  })

  test("a renewal already made is reused, not bought twice", async () => {
    // the record a hook is handed can lag behind a renewal another hook just
    // made — signing in again would spend a second session for nothing
    store.auth = { ...creds(), access: "gone" }
    await store.plugin.auth.usage(store.getAuth)
    expect(fake.state.pwdCalls).toBe(1)
    store.saves.length = 0
    // still the stale copy, as an unsaved record would be
    store.auth = { ...creds(), access: "gone" }
    const again = await store.plugin.auth.usage(store.getAuth)
    expect(again.signIn).toBeUndefined()
    expect(fake.state.pwdCalls).toBe(1)
    expect(store.saves).toHaveLength(0)
  })

  test("no password to renew with: usage still reports the lapse", async () => {
    store.auth = { type: "oauth", access: "gone", expires: 0, accountId: "手动粘贴", refresh: "" }
    const usage = await store.plugin.auth.usage(store.getAuth)
    expect(usage.signIn).toBe("expired")
    expect(fake.state.pwdCalls).toBe(0)
  })
})

