// The request format option: a chat to WorkBuddy's China build can go out in
// the shape of the official CodeBuddy CLI 2.108.1 instead of WorkBuddy's own
// desktop app. What that shape is comes from durindoor's
// docs/providers/codebuddy-cn.md, whose version history records what each
// release contributes, so this file checks the plugin against that table
// rather than against a reading of the CLI's bundle.
//
// Nothing of the option reaches anything but a chat. /v1/messages and
// count_tokens are another API, whose headers no CodeBuddy capture
// describes; the product config, the meter and the check-in are not chats at
// all. WorkBuddy AI has the one format. And a value naming no format this
// plugin knows sends what every request sent before the option existed.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { gunzipSync } from "node:zlib"
import { WorkBuddyAIAuthPlugin, WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
beforeEach(() => {
  _internal.renewing.clear()
  _internal.renewed.clear()
})
afterEach(() => {
  globalThis.fetch = real
  _internal.desktopHeld.clear()
})

const later = () => Date.now() + 3600_000
const STREAM = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const ok = (data = {}) => new Response(JSON.stringify({ code: 0, msg: "ok", data }))

// serve answers the paths given and records what was asked, the headers the
// plugin left on each request included
function serve(routes) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    const h = new Headers(init?.headers)
    calls.push({ url: u, init, headers: h })
    const r = routes[u.pathname]
    return r ? r(init, h) : STREAM()
  }
  return calls
}

// chat sends one chat through the plugin as magpie's host does, with the
// options the package's entry carries, and answers what went out
async function chat({ body, options, url = "https://copilot.tencent.com/v2/chat/completions", plugin = WorkBuddyAuthPlugin, auth } = {}) {
  const calls = serve({})
  const hooks = await plugin({ client: {} }, options)
  const l = await hooks.auth.loader(async () => auth ?? { type: "oauth", access: "at", refresh: "r", uid: "u1", expires: later() })
  const res = await l.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  await res.text()
  const sent = calls.at(-1)
  return { headers: sent.headers, body: text(sent.init?.body), raw: sent.init?.body, calls }
}

const text = (b) => {
  if (b == null) return ""
  if (typeof b === "string") return b
  const u = new Uint8Array(b)
  // a gzipped body starts 1f 8b; nothing here decodes it, and the tests that
  // care say so by asking for the encoding rather than the bytes
  if (u[0] === 0x1f && u[1] === 0x8b) return "<gzip>"
  return new TextDecoder().decode(u)
}

const send = (text, extra = {}) => ({ model: "glm-5.3", stream: true, messages: [{ role: "system", content: "be brief" }, { role: "user", content: text }], ...extra })
const FORMAT = { requestFormat: "codebuddy-2108" }

// WHAT_2108 is the header surface 2.108.1 sends on a chat, by the table in
// durindoor's docs/providers/codebuddy-cn.md: the six identity headers its
// release contributes, the CLI's own naming of itself, and the bundled OpenAI
// SDK's headers. X-Agent-Type (2.138.0), X-Agent-Runtime (2.172.1),
// X-Root-Request-ID and the seven b3/traceparent headers (2.138.0), baggage
// (2.164.0), cache_retention and extra_vars (2.172.1) and X-Stainless-Timeout
// (never, in any capture) are all absent.
const WHAT_2108 = {
  "user-agent": "CLI/2.108.1 CodeBuddy/2.108.1",
  "x-ide-version": "2.108.1",
  "x-ide-type": "CLI",
  "x-ide-name": "CLI",
  "x-product": "SaaS",
  "x-codebuddy-request": "1",
  "x-requested-with": "XMLHttpRequest",
  "x-agent-intent": "craft",
  "x-agent-purpose": "conversation",
  "x-private-data": "false",
  accept: "application/json",
  "x-stainless-retry-count": "0",
  "x-stainless-lang": "js",
  "x-stainless-package-version": "6.25.0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": process.version,
}

const NOT_2108 = [
  "x-agent-type",
  "x-agent-runtime",
  "x-stainless-timeout",
  "x-root-request-id",
  "traceparent",
  "b3",
  "x-b3-traceid",
  "x-b3-spanid",
  "x-b3-parentspanid",
  "x-b3-sampled",
  "x-trace-id",
  "baggage",
]

test("a chat in 2.108.1's format carries its headers and none of a later release's", async () => {
  const { headers } = await chat({ body: send("hi"), options: FORMAT })
  for (const [k, v] of Object.entries(WHAT_2108)) expect([k, headers.get(k)]).toEqual([k, v])
  for (const k of NOT_2108) expect([k, headers.get(k)]).toEqual([k, null])
})

test("the headers 2.108.1 keeps are the ones it kept before: the sign-in and the host", async () => {
  const { headers } = await chat({ body: send("hi"), options: FORMAT })
  expect(headers.get("authorization")).toBe("Bearer at")
  expect(headers.get("x-user-id")).toBe("u1")
  expect(headers.get("x-domain")).toBe("copilot.tencent.com")
  expect(headers.get("content-type")).toBe("application/json")
})

test("an enterprise account says so, as the CLI's own resolution does", async () => {
  const auth = { type: "oauth", access: "at", refresh: "r", uid: "u1", enterpriseId: "ent-9", expires: later() }
  const { headers } = await chat({ body: send("hi"), options: FORMAT, auth })
  expect(headers.get("x-private-data")).toBe("true")
  expect(headers.get("x-enterprise-id")).toBe("ent-9")
  expect(headers.get("x-tenant-id")).toBe("ent-9")
})

test("a conversation's ids still travel: 2.108.1 contributes all four", async () => {
  const { headers } = await chat({ body: send("hi"), options: FORMAT })
  const HEX32 = /^[0-9a-f]{32}$/
  expect(headers.get("x-conversation-message-id")).toMatch(HEX32)
  expect(headers.get("x-request-id")).toBe(headers.get("x-conversation-message-id"))
  expect(headers.get("x-conversation-request-id")).toMatch(HEX32)
  expect(headers.get("x-conversation-id")).toMatch(HEX32)
})

test("nothing is gzipped: no CodeBuddy capture carries a Content-Encoding", async () => {
  const { headers, body } = await chat({ body: send("hi"), options: FORMAT })
  expect(headers.get("content-encoding")).toBe(null)
  expect(body).not.toBe("<gzip>")
  expect(JSON.parse(body).model).toBe("glm-5.3")
})

test("a chat in the plugin's own format still gzips, so the option is what changed", async () => {
  const { headers, body } = await chat({ body: send("hi") })
  expect(headers.get("content-encoding")).toBe("gzip")
  expect(headers.get("user-agent")).toBe("WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0")
  expect(headers.get("x-agent-type")).toBe("main")
  expect(headers.get("x-agent-runtime")).toBe("local-agent")
  expect(headers.get("x-stainless-timeout")).toBe("1200")
})

// The two body fields. 2.108.1's model-settings interceptor writes
// verbosity:"high" whenever thinking is on and injectReasoningSummaryIfNeeded
// writes reasoning_summary:"auto"; both travel beside a reasoning_effort and
// never on a request that asked for none (forcing reasoning on a plain
// request makes CodeBuddy trip its content filter).

test("a chat that asks for thinking goes with both fields, as the CLI stamps them", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "high" }), options: FORMAT })
  const b = JSON.parse(body)
  expect([b.reasoning_effort, b.reasoning_summary, b.verbosity]).toEqual(["high", "auto", "high"])
})

test("a chat told not to think keeps saying so, and gains neither", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "none" }), options: FORMAT })
  const b = JSON.parse(body)
  expect(b.reasoning_effort).toBe("none")
  expect("reasoning_summary" in b).toBe(false)
  expect("verbosity" in b).toBe(false)
})

test("off is the same as none", async () => {
  const { body } = await chat({ body: send("hi", { reasoning: { effort: "off" } }), options: FORMAT })
  const b = JSON.parse(body)
  expect("reasoning_summary" in b).toBe(false)
  expect("verbosity" in b).toBe(false)
})

test("a caller's own values are kept, not overwritten", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "high", reasoning_summary: "concise", verbosity: "low" }), options: FORMAT })
  const b = JSON.parse(body)
  expect([b.reasoning_summary, b.verbosity]).toEqual(["concise", "low"])
})

test("the plugin's own format stamps neither field, as it never did", async () => {
  const { headers, raw } = await chat({ body: send("hi", { reasoning_effort: "high" }) })
  expect(headers.get("content-encoding")).toBe("gzip")
  const b = JSON.parse(gunzipSync(Buffer.from(raw)).toString())
  expect(b.reasoning_summary).toBeUndefined()
  expect(b.verbosity).toBeUndefined()
})

// The guards: what the option must not reach.

test("/v1/messages keeps the plugin's own headers whatever the option says", async () => {
  const { headers } = await chat({
    body: { model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
    options: FORMAT,
    url: "https://copilot.tencent.com/v1/messages",
  })
  expect(headers.get("user-agent")).toBe("WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0")
  expect(headers.get("x-ide-type")).toBe("WorkBuddy")
  expect(headers.get("x-codebuddy-request")).toBe(null)
})

test("count_tokens keeps them too", async () => {
  const { headers } = await chat({
    body: { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] },
    options: FORMAT,
    url: "https://copilot.tencent.com/v1/messages/count_tokens",
  })
  expect(headers.get("user-agent")).toBe("WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0")
})

test("WorkBuddy AI has the one format: the option is about the China build's chat", async () => {
  const { headers } = await chat({
    body: send("hi"),
    options: FORMAT,
    plugin: WorkBuddyAIAuthPlugin,
    url: "https://www.workbuddy.ai/v2/chat/completions",
  })
  expect(headers.get("user-agent")).toBe("WorkBuddy/5.9.3 workbuddy-ai/5.9.3 CLI/2.165.0")
  expect(headers.get("x-agent-type")).toBe("main")
})

test("a value naming no format sends what every request sent before the option", async () => {
  for (const bogus of ["codebuddy-2138", "", "CLI", true, 2108, null]) {
    const { headers } = await chat({ body: send("hi"), options: { requestFormat: bogus } })
    expect([bogus, headers.get("user-agent")]).toEqual([bogus, "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0"])
  }
})

test("no options at all is the format the plugin always sent", async () => {
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  expect(hooks).toBeTruthy()
  const { headers } = await chat({ body: send("hi"), options: undefined })
  expect(headers.get("user-agent")).toBe("WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0")
})

// What is not a chat at all.

test("the product config is read in the plugin's own format", async () => {
  const calls = serve({ "/v3/config": () => ok({ agents: [{ name: "cli", models: [] }] }) })
  await _internal.liveModels(_internal.SITES.workbuddy, { access: "at", uid: "u1", domain: "", source: "oauth" })
  expect(calls[0].headers.get("user-agent")).toBe("WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0")
})

test("the meter and the check-in are not chats: their headers do not move", async () => {
  const calls = serve({
    "/billing/meter/get-user-resource-summary": () => ok({ IsPaidUser: true, Packages: [] }),
    "/v2/billing/meter/checkin-activity-status": () => ok({ active: true, todayCheckedIn: false }),
    "/v2/billing/meter/daily-checkin": () => ok(),
  })
  const auth = { type: "oauth", access: "at", refresh: "r", uid: "u1", domain: "", expires: later() }
  const hooks = await WorkBuddyAuthPlugin({ client: {} }, FORMAT)
  await hooks.auth.usage(async () => auth)
  await hooks.auth.checkin(async () => auth)
  expect(calls.length).toBeGreaterThanOrEqual(3)
  for (const c of calls) expect(c.headers.get("user-agent")).toBe("WorkBuddy/5.9.3")
  for (const c of calls) expect(c.headers.get("x-codebuddy-request")).toBe(null)
})

// A 401 is answered by signing in again and sending once more, so the resend
// carries the same format as the first try — an account refreshed into the
// plugin's own headers would be a fingerprint that changes mid-conversation.

test("a resend after a renewed token keeps the format", async () => {
  let n = 0
  const calls = serve({
    "/v2/plugin/auth/token/refresh": () => ok({ accessToken: "at2", refreshToken: "r2", expiresAt: Date.now() + 3600_000 }),
    "/v2/chat/completions": () => (++n === 1 ? new Response("", { status: 401 }) : STREAM()),
  })
  const auth = { type: "oauth", access: "at", refresh: "r", uid: "u1", expires: later() }
  const hooks = await WorkBuddyAuthPlugin({ client: { auth: { set: async () => {} } } }, FORMAT)
  const l = await hooks.auth.loader(async () => auth)
  const res = await l.fetch("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(send("hi")),
  })
  await res.text()
  const chats = calls.filter((c) => c.url.pathname === "/v2/chat/completions")
  expect(chats).toHaveLength(2)
  for (const c of chats) {
    expect(c.headers.get("user-agent")).toBe("CLI/2.108.1 CodeBuddy/2.108.1")
    expect(c.headers.get("x-ide-type")).toBe("CLI")
    expect(c.headers.get("x-stainless-timeout")).toBe(null)
  }
  expect(chats[1].headers.get("authorization")).toBe("Bearer at2")
})
