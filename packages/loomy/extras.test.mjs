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
  foldEffort,
  foldReasoningBody,
  ledgerFile,
  needsTagFormat,
  traceHeaders,
  _internal as extras,
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
  extras.resetVisionCache()
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

describe("thinking levels", () => {
  test("the six levels walk two at a time into the vendor's three", () => {
    expect(foldEffort("minimal")).toBe("low")
    expect(foldEffort("low")).toBe("low")
    expect(foldEffort("medium")).toBe("medium")
    expect(foldEffort("high")).toBe("medium")
    expect(foldEffort("xhigh")).toBe("high")
    expect(foldEffort("max")).toBe("high")
  })

  test("levels the vendor does not take fold away, so its default stands", () => {
    expect(foldEffort("none")).toBeNull()
    expect(foldEffort("off")).toBeNull()
    expect(foldEffort("banana")).toBeNull()
    expect(foldEffort(undefined)).toBeNull()
  })

  test("xhigh reaches the gateway as high instead of being deleted", () => {
    // the old table dropped it and the gateway fell back to low: the highest
    // setting an agent could ask for came out as the lowest
    const body = { reasoning_effort: "xhigh" }
    expect(foldReasoningBody(body)).toBe(true)
    expect(body.reasoning_effort).toBe("high")
  })

  test("the nested reasoning.effort form is folded the same way", () => {
    const body = { reasoning: { effort: "high" } }
    foldReasoningBody(body)
    expect(body.reasoning.effort).toBe("medium")
  })

  test("a level already in range is left alone and reports no change", () => {
    const body = { reasoning_effort: "medium", reasoning: { effort: "low" } }
    expect(foldReasoningBody(body)).toBe(false)
    expect(body.reasoning_effort).toBe("medium")
    expect(body.reasoning.effort).toBe("low")
  })

  test("off/none is deleted rather than sent as something the gateway ignores", () => {
    const body = { reasoning_effort: "none", reasoning: { effort: "off" } }
    foldReasoningBody(body)
    expect(body.reasoning_effort).toBeUndefined()
    expect(body.reasoning.effort).toBeUndefined()
  })
})

describe("which models read images", () => {
  test("the live catalog decides, not the name", async () => {
    // deepseek-v4-flash declares vision:true, so it reads image parts
    expect(await needsTagFormat("deepseek-v4-flash", session())).toBe(false)
    // and a model with no vision capability gets the marker form
    expect(await needsTagFormat("spark-x", session())).toBe(true)
  })

  test("the catalog is read once and reused", async () => {
    await needsTagFormat("deepseek-v4-flash", session())
    const reads = fake.state.modelsReads
    await needsTagFormat("spark-x", session())
    expect(fake.state.modelsReads).toBe(reads)
  })

  test("a model the catalog has never heard of falls back to the name", async () => {
    expect(await needsTagFormat("deepseek-v9-future", session())).toBe(true)
    expect(await needsTagFormat("brand-new-model", session())).toBe(false)
  })

  test("an unreadable catalog falls back to the name rather than guessing", async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = String(typeof input === "string" ? input : input?.url)
      if (url.includes("/api/v1/models")) return Promise.resolve(new Response("boom", { status: 502 }))
      return realFetch(input, init)
    }
    try {
      expect(await needsTagFormat("deepseek-v4-1-flash", session())).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

describe("trace headers", () => {
  test("the W3C shape the client sends", () => {
    const h = traceHeaders()
    expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(h["loomy-version"]).toBe("0.9.38")
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
    expect(seen.get("loomy-version")).toBe("0.9.38")
    // and the headers that were already load-bearing are still there
    expect(seen.get("token")).toBe(session())
    expect(seen.get("content-type")).toContain("charset=utf-8")
  })
})

function readFileSyncOrNull(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}
