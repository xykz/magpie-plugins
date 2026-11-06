import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LoomyAuthPlugin } from "./index.mjs"
import { fakeLoomy } from "./fake.mjs"
import {
  ONBOARDING_TASKS,
  ONBOARDING_TOTAL,
  accountKeyOf,
  claimOnboarding,
  extendLoomy,
  ledgerFile,
  traceHeaders,
} from "./extras.mjs"

// the fake upstream from fake.mjs: no network, no real token ever leaves here

let fake
let tempDir

beforeAll(() => {
  fake = fakeLoomy()
  process.env.LOOMY_POINTS_BASE_URL = fake.gatewayUrl
  process.env.LOOMY_XFYUN_BASE_URL = fake.accountUrl
})

afterAll(() => {
  fake.account.stop(true)
  fake.gateway.stop(true)
})

beforeEach(() => {
  fake.state.reset()
  tempDir = mkdtempSync(join(tmpdir(), "loomy-extras-"))
  process.env.LOOMY_ONBOARDING_LEDGER = join(tempDir, "ledger.json")
  delete process.env.LOOMY_ONBOARDING
})

afterEach(() => {
  delete process.env.LOOMY_ONBOARDING_LEDGER
  rmSync(tempDir, { recursive: true, force: true })
})

const session = () => fake.state.session
const who = { userId: "u-1" }

describe("onboarding tasks", () => {
  test("the eight keys add up to the 10000 the vendor pays", () => {
    expect(ONBOARDING_TASKS).toHaveLength(8)
    expect(ONBOARDING_TOTAL).toBe(10000)
    expect(ONBOARDING_TASKS.map((t) => t.key).sort()).toEqual([
      "configure_remote",
      "create_soul",
      "first_message",
      "generate_ppt",
      "install_skill",
      "pick_skill",
      "set_schedule",
      "share_soul",
    ])
  })

  test("a fresh account claims all eight, and says which", async () => {
    const gift = await claimOnboarding(session(), who)
    expect(gift.points).toBe(10000)
    expect(gift.keys).toHaveLength(8)
    expect(gift.settled).toBe(true)
    expect(fake.state.onboardingCompletes).toBe(8)
    expect(fake.state.onboardingDone).toEqual({
      share_soul: true,
      generate_ppt: true,
      install_skill: true,
      create_soul: true,
      pick_skill: true,
      set_schedule: true,
      configure_remote: true,
      first_message: true,
    })
  })

  test("the ledger is on disk, so a settled account costs nothing next time", async () => {
    await claimOnboarding(session(), who)
    const onDisk = JSON.parse(readFileSync(process.env.LOOMY_ONBOARDING_LEDGER, "utf8"))
    expect(onDisk["u-1"]).toHaveLength(8)

    const before = fake.state.onboardingCompletes
    const again = await claimOnboarding(session(), who)
    expect(again.points).toBe(0)
    expect(again.skipped).toBe("already-settled")
    expect(fake.state.onboardingCompletes).toBe(before) // not one request
  })

  test("a key the server calls already-completed is settled but pays nothing", async () => {
    // somebody claimed pick_skill in the client before installing the plugin
    fake.state.onboardingDone.pick_skill = true
    const gift = await claimOnboarding(session(), who)
    expect(gift.points).toBe(10000 - 1000)
    expect(gift.keys).not.toContain("pick_skill")
    // and it is not asked about again tomorrow
    const again = await claimOnboarding(session(), who)
    expect(again.skipped).toBe("already-settled")
  })

  test("a dead session stops the loop instead of spending eight calls on it", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url)
      if (url.includes("/onboarding/tasks/complete")) {
        return Promise.resolve(new Response(JSON.stringify({ code: "100002", desc: "缺少 token" }), { status: 200 }))
      }
      return realFetch(input, init)
    }
    try {
      const gift = await claimOnboarding("dead-session", who)
      expect(gift.expired).toBe(true)
      expect(gift.points).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
    // nothing was written: the keys are still up for grabs on a good session
    expect(readFileSyncOrNull(process.env.LOOMY_ONBOARDING_LEDGER)).toBeNull()
  })

  test("accounts are kept apart: one account's ledger entries do not cover another's", async () => {
    await claimOnboarding(session(), { userId: "u-1" })
    const onDisk = JSON.parse(readFileSync(process.env.LOOMY_ONBOARDING_LEDGER, "utf8"))
    expect(Object.keys(onDisk)).toEqual(["u-1"])

    // the second account asks for its own eight keys rather than being told
    // "already settled" from the first account's ledger. (This fake's
    // server-side task state is global, so it pays nothing here — what the
    // test is about is that the requests go out at all.)
    const before = fake.state.onboardingCompletes
    const other = await claimOnboarding(session(), { userId: "u-2" })
    expect(fake.state.onboardingCompletes).toBe(before + 8)
    expect(other.keys).toHaveLength(0)
    const after = JSON.parse(readFileSync(process.env.LOOMY_ONBOARDING_LEDGER, "utf8"))
    expect(Object.keys(after).sort()).toEqual(["u-1", "u-2"])
    expect(after["u-2"]).toHaveLength(8)
  })

  test("the ledger's key falls back from userId through accountId to the session", () => {
    expect(accountKeyOf({ userId: "u-1", accountId: "138****8000" })).toBe("u-1")
    expect(accountKeyOf({ accountId: "138****8000" })).toBe("138****8000")
    expect(accountKeyOf({ access: "abcdefghijklmnop" })).toBe("session:abcdefghijkl")
    expect(accountKeyOf({})).toBe("default")
  })

  test("LOOMY_ONBOARDING_LEDGER moves the file", () => {
    expect(ledgerFile()).toBe(process.env.LOOMY_ONBOARDING_LEDGER)
  })
})

describe("the check-in hook carries the gifts", () => {
  test("a fresh account's check-in reports the daily grant and the 10000 together", async () => {
    const saved = { type: "oauth", access: session(), expires: 0, accountId: "138****8000", userId: "u-1" }
    const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })
    const result = await plugin.auth.checkin(async () => saved)
    expect(result.outcome).toBe("claimed")
    // 2000 from the fake's daily wallet (3000 → 5000) plus the eight tasks
    expect(result.credit).toBe(12000)
    expect(result.message).toContain("新手任务")
  })

  test("the second check-in of the day adds nothing: the gifts are settled", async () => {
    const saved = { type: "oauth", access: session(), expires: 0, accountId: "138****8000", userId: "u-1" }
    const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })
    await plugin.auth.checkin(async () => saved)
    const before = fake.state.onboardingCompletes
    const again = await plugin.auth.checkin(async () => saved)
    expect(again.outcome).toBe("done")
    expect(again.credit).toBeUndefined()
    expect(fake.state.onboardingCompletes).toBe(before)
  })

  test("a failed daily grant is passed through, gifts and all", async () => {
    const base = { outcome: "failed", message: "每日积分刷新失败：boom" }
    const wrapped = extendLoomy({ auth: { checkin: async () => base } })
    const result = await wrapped.auth.checkin(async () => ({ access: session() }))
    expect(result).toBe(base)
    expect(fake.state.onboardingCompletes).toBe(0)
  })

  test("LOOMY_ONBOARDING=0 turns the gifts off", async () => {
    process.env.LOOMY_ONBOARDING = "0"
    const base = { outcome: "done", message: "每日赠送积分已刷新" }
    const wrapped = extendLoomy({ auth: { checkin: async () => base } })
    const result = await wrapped.auth.checkin(async () => ({ access: session() }))
    expect(result).toBe(base)
    expect(fake.state.onboardingCompletes).toBe(0)
  })

  test("a plugin without a check-in hook is returned untouched", () => {
    const plugin = { auth: { provider: "loomy" }, provider: { id: "loomy" } }
    expect(extendLoomy(plugin)).toBe(plugin)
  })
})

describe("trace headers", () => {
  test("the W3C shape the client sends", () => {
    const h = traceHeaders()
    expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(h["loomy-version"]).toBe("0.9.39")
  })

  test("every call gets its own trace id", () => {
    expect(traceHeaders().traceparent).not.toBe(traceHeaders().traceparent)
  })

  test("the chat request carries them", async () => {
    const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: session(), expires: 0 }))
    const realFetch = globalThis.fetch
    let seen = null
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url)
      if (url.includes("/chat/completions")) seen = new Headers(init?.headers)
      return realFetch(input, init)
    }
    try {
      await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
      })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(seen.get("loomy-version")).toBe("0.9.39")
  })

  // The chat plane's header set, asserted against the client's own recorded
  // traffic (.sandbox/loomy-captures/real-windows*/): Bearer auth, no token,
  // bare application/json, */*, and the attribution headers.
  test("the chat headers are the client's, not the plugin's old ones", async () => {
    const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: session(), expires: 0 }))
    const realFetch = globalThis.fetch
    let seen = null
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url)
      if (url.includes("/chat/completions")) seen = new Headers(init?.headers)
      return realFetch(input, init)
    }
    try {
      await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-magpie-session": "ses_abc123" },
        body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
      })
    } finally {
      globalThis.fetch = realFetch
    }
    // auth: Bearer, and no `token` header on this plane
    expect(seen.get("authorization")).toBe(`Bearer ${session()}`)
    expect(seen.get("token")).toBeNull()
    // content type: bare, no charset
    expect(seen.get("content-type")).toBe("application/json")
    // the same media range the client's opencode plane asks for
    expect(seen.get("accept")).toBe("*/*")
    // attribution. `ses_abc123` is not a shape opencode could have minted, so
    // the affinity is derived from it (the opencode-shaped case is asserted in
    // headers.test.mjs); what matters here is that a shape goes out at all
    expect(seen.get("x-session-affinity")).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(seen.get("chatid")).toMatch(/^chat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(seen.get("msgid")).toMatch(/^msg-[0-9a-f-]{36}$/)
    expect(seen.get("turnid")).toBe(seen.get("msgid")) // the client's turn == its msg
    expect(seen.get("invokeorigin")).toBe("user")
    expect(seen.get("x-loomy-request-purpose")).toBe("chat.message")
    // and no magpie-only header leaks upstream
    expect(seen.get("x-magpie-session")).toBeNull()
  })

  test("the chatid is stable per session, the msgid is not", async () => {
    const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: session(), expires: 0 }))
    const realFetch = globalThis.fetch
    const seen = []
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url)
      if (url.includes("/chat/completions")) seen.push(new Headers(init?.headers))
      return realFetch(input, init)
    }
    try {
      for (let i = 0; i < 2; i++)
        await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-magpie-session": "ses_stable" },
          body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
        })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen[0].get("chatid")).toBe(seen[1].get("chatid"))
    expect(seen[0].get("msgid")).not.toBe(seen[1].get("msgid"))
  })

  test("a session id that is already sha-shaped still yields a chat-<uuid>", async () => {
    // magpie's own conversationID is `magpie-<sha256[:24]>`, a shape no Loomy
    // client ever sends; the chatid must not echo it
    const { chatIdFor } = await import("./headers.mjs")
    const id = chatIdFor("magpie-0123456789abcdef01234567")
    expect(id).toMatch(/^chat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).not.toContain("magpie")
  })

  test("no session header means no chatid/affinity, but the turn ids still go", async () => {
    const plugin = await LoomyAuthPlugin({ client: { auth: { set: async () => {} } } })
    const loader = await plugin.auth.loader(async () => ({ type: "oauth", access: session(), expires: 0 }))
    const realFetch = globalThis.fetch
    let seen = null
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url)
      if (url.includes("/chat/completions")) seen = new Headers(init?.headers)
      return realFetch(input, init)
    }
    try {
      await loader.fetch(`${fake.gatewayUrl}/api/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "spark-x", stream: false, messages: [] }),
      })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen.get("chatid")).toBeNull()
    expect(seen.get("x-session-affinity")).toBeNull()
    expect(seen.get("msgid")).toBeTruthy()
  })
})

function readFileSyncOrNull(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}
