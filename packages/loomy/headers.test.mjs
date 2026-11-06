// The header module on its own. index.test.mjs and extras.test.mjs assert what
// actually leaves through the loader; this file pins the pieces those tests
// lean on, so a failure says which part broke.

import { describe, expect, test } from "bun:test"
import {
  AXIOS_ACCEPT,
  accountUserAgent,
  chatAttribution,
  chatIdFor,
  clientUserAgent,
  conversationSeed,
  isSessionId,
  newMessageId,
  sessionAffinityOf,
  sessionIdOf,
  traceparent,
} from "./headers.mjs"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe("user agents", () => {
  // The two planes are reached by different runtimes in the real client:
  // opencode for the gateway, axios for the account domain. magpie's host
  // runs bun with no UA flag, so neither value appears on its own.
  test("the gateway UA is opencode's composite string", () => {
    expect(clientUserAgent()).toBe("opencode/1.14.22 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13")
  })

  test("the account UA is axios'", () => {
    expect(accountUserAgent()).toBe("axios/1.21.0")
    expect(AXIOS_ACCEPT).toBe("application/json, text/plain, */*")
  })

  test("both are overridable for a build that knows the versions moved", async () => {
    const { clientUserAgent: c, accountUserAgent: a } = await import(`./headers.mjs?bust=${Date.now()}`)
    process.env.LOOMY_CLIENT_UA = "opencode/9.9.9"
    process.env.LOOMY_ACCOUNT_UA = "axios/9.9.9"
    try {
      expect(c()).toBe("opencode/9.9.9")
      expect(a()).toBe("axios/9.9.9")
    } finally {
      delete process.env.LOOMY_CLIENT_UA
      delete process.env.LOOMY_ACCOUNT_UA
    }
  })
})

describe("session identity", () => {
  test("magpie's session header is what the client's affinity comes from", () => {
    expect(sessionIdOf({ "x-magpie-session": "ses_abc" })).toBe("ses_abc")
    expect(sessionIdOf({ "X-Magpie-Session": "ses_abc" })).toBe("ses_abc")
    expect(sessionIdOf(new Headers({ "x-magpie-session": "ses_abc" }))).toBe("ses_abc")
    expect(sessionIdOf([["x-magpie-session", "ses_abc"]])).toBe("ses_abc")
    expect(sessionIdOf({})).toBeUndefined()
    expect(sessionIdOf(undefined)).toBeUndefined()
    // blank is the same as absent
    expect(sessionIdOf({ "x-magpie-session": "   " })).toBeUndefined()
  })

  test("chatid is a uuid4 with the client's chat- prefix", () => {
    const id = chatIdFor("ses_abc")
    expect(id).toMatch(/^chat-/)
    expect(id.slice(5)).toMatch(UUID_V4)
    expect(chatIdFor(undefined)).toBeUndefined()
  })

  test("chatid is stable per session and different across sessions", () => {
    expect(chatIdFor("ses_a")).toBe(chatIdFor("ses_a"))
    expect(chatIdFor("ses_a")).not.toBe(chatIdFor("ses_b"))
  })

  test("a derived chatid is still a valid v4 (version and variant nibbles)", () => {
    // A sha256 hex string rewritten at the right nibbles, so a naive
    // hash-as-uuid would fail this
    for (const seed of ["ses_1", "ses_2", "magpie-0123456789abcdef01234567"]) {
      const id = chatIdFor(seed).slice(5)
      expect(id[14]).toBe("4")
      expect("89ab").toContain(id[19])
    }
  })

  test("msgid is per call, not derived", () => {
    expect(newMessageId()).toMatch(/^msg-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newMessageId()).not.toBe(newMessageId())
  })
})

// The affinity is the one attribution header whose incoming value is not the
// plugin's to choose: magpie hands it whatever session the calling agent named
// (internal/gateway/gateway.go sessionOf, nine header names), so it may be
// opencode's `ses_…`, Claude Code's `cc-…`, a bare uuid, or nothing. Only the
// first of those is sent as it is.
describe("x-session-affinity", () => {
  test("every captured value passes the opencode-shape check", () => {
    for (const v of [
      "ses_e547f867bffetihm0xyJ6NJ42H",
      "ses_e54f3a6dbffe9mzLDtwrBttbtW",
      "ses_e547f65acffeuoTGaPr6fU2A3g",
      "ses_e547f65c9ffey3kyzyy9KibWrS",
      "ses_e54f39975ffeZGwmmW6FQhTMva",
      "ses_e54f3997dffefacHVFoebJOZ7T",
    ]) {
      expect(isSessionId(v)).toBe(true)
    }
  })

  test("another harness's id, a bare uuid and nothing are not that shape", () => {
    for (const v of [
      "cc-7b2f1a8e-4d3c",
      "0193f0a1-7c2e-7f3a-9b1d-2e4c6a8f0b1d",
      "ses_x",
      "my-session-1",
      // right shape, but a counter no real one has (a hash cut to fit)
      "ses_0123456789abZZZZZZZZZZZZZZ",
      "",
      undefined,
      null,
    ]) {
      expect(isSessionId(v)).toBe(false)
    }
  })

  test("a derived affinity has the client's own shape and a small counter", () => {
    for (const seed of ["ses_x", "cc-7b2f1a8e-4d3c", "我的会话-第三轮", "magpie-0123456789abcdef01234567"]) {
      const id = sessionAffinityOf(seed)
      expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      // its low 12 bits are a counter, so the id is one real opencode ids can
      // sit beside (0xfff - counter < 16, as realSessionID tests)
      expect(isSessionId(id)).toBe(true)
      expect(id.length).toBe(30)
    }
  })

  test("a derived affinity is deterministic: the same seed, the same id", () => {
    expect(sessionAffinityOf("ses_x")).toBe(sessionAffinityOf("ses_x"))
    expect(sessionAffinityOf("ses_x")).not.toBe(sessionAffinityOf("ses_y"))
  })

  test("an opencode-shaped session goes through untouched", () => {
    const real = "ses_e547f867bffetihm0xyJ6NJ42H"
    const h = chatAttribution({ "x-magpie-session": real })
    expect(h["x-session-affinity"]).toBe(real)
  })

  test("any other caller's id is replaced by one of the right shape", () => {
    for (const given of ["cc-7b2f1a8e-4d3c", "my session 1", "我的会话-第三轮"]) {
      const h = chatAttribution({ "x-magpie-session": given })
      expect(h["x-session-affinity"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(h["x-session-affinity"]).not.toBe(given)
      expect(h["x-session-affinity"]).not.toContain(given)
    }
  })

  test("a non-ASCII session id no longer kills the request at the Headers call", () => {
    // measured before the change: `new Headers()` threw
    // "Header 'x-session-affinity' has invalid value" and the loader answered
    // 502 without ever sending anything
    const h = chatAttribution({ "x-magpie-session": "我的会话-第三轮" })
    expect(() => new Headers(h)).not.toThrow()
  })
})

describe("conversation seed", () => {
  test("the session the caller named is the seed when there is one", () => {
    expect(conversationSeed({ "x-magpie-session": "ses_1" }, { messages: [{ role: "user", content: "hi" }] })).toBe("ses_1")
  })

  test("with no session the opening user message names the conversation", () => {
    const seed = conversationSeed({}, { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] })
    expect(seed).toBe("opening:user\u0000hi")
    expect(conversationSeed({}, { messages: [{ role: "user", content: "hi" }] })).toBe(seed)
    expect(conversationSeed({}, { messages: [{ role: "user", content: "other" }] })).not.toBe(seed)
  })

  test("only the words are read, so a conversation's next turns keep the seed", () => {
    const one = conversationSeed({}, { messages: [{ role: "user", content: "hi" }] })
    const two = conversationSeed({}, { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] })
    expect(two).toBe(one)
  })

  test("an image part's base64 does not enter the seed", () => {
    // one captured opening message is 533,420 bytes, all of it a data url
    const img = { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(500_000) } }] }
    const seed = conversationSeed({}, { messages: [img] })
    expect(seed.length).toBeLessThan(100)
    expect(seed).not.toContain("AAAA")
  })

  test("a long paste is capped", () => {
    const seed = conversationSeed({}, { messages: [{ role: "user", content: "x".repeat(50_000) }] })
    expect(seed.length).toBeLessThanOrEqual(4096 + 8)
  })

  test("an input-shaped body reads its first element too", () => {
    expect(conversationSeed({}, { input: [{ role: "user", content: "hi" }] })).toBe("opening:user\u0000hi")
  })

  test("nothing to name the conversation with means no session-scoped header", () => {
    expect(conversationSeed({}, undefined)).toBeUndefined()
    expect(conversationSeed({}, {})).toBeUndefined()
    expect(conversationSeed({}, { messages: [] })).toBeUndefined()
    const h = chatAttribution({}, { messages: [] })
    expect(h["x-session-affinity"]).toBeUndefined()
    expect(h.chatid).toBeUndefined()
  })

  test("a body with no session still names the conversation, so both ids go", () => {
    const h = chatAttribution({}, { messages: [{ role: "user", content: "hi" }] })
    expect(h["x-session-affinity"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(h.chatid).toMatch(/^chat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe("attribution", () => {
  test("a chat carries the client's six headers", () => {
    const h = chatAttribution({ "x-magpie-session": "ses_x" })
    expect(h["user-agent"]).toBe(clientUserAgent())
    // `ses_x` is not a shape opencode could have minted, so it is derived
    expect(h["x-session-affinity"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(h.chatid).toMatch(/^chat-/)
    expect(h.msgid).toMatch(/^msg-/)
    expect(h.turnid).toBe(h.msgid) // the client's turn id IS the msg id
    expect(h.invokeorigin).toBe("user")
    expect(h["x-loomy-request-purpose"]).toBe("chat.message")
  })

  test("without a session the turn ids still go, the session-scoped ones do not", () => {
    const h = chatAttribution({})
    expect(h.chatid).toBeUndefined()
    expect(h["x-session-affinity"]).toBeUndefined()
    expect(h.msgid).toBeTruthy()
    expect(h.turnid).toBe(h.msgid)
  })

  test("an unknown purpose is dropped, not sent", () => {
    // the client's own rule: 宁可不发头，也不要发一个服务端不认识的值
    // (the plugin cannot pass a purpose through at all: it only ever sees a
    // chat, so the value is fixed by construction — see the module's note)
    expect(chatAttribution({})["x-loomy-request-purpose"]).toBe("chat.message")
  })

  test("the origin is fixed to user", () => {
    expect(chatAttribution({}).invokeorigin).toBe("user")
  })
})

describe("traceparent", () => {
  test("the W3C shape", () => {
    expect(traceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })

  test("never repeats", () => {
    const seen = new Set(Array.from({ length: 50 }, () => traceparent()))
    expect(seen.size).toBe(50)
  })
})
