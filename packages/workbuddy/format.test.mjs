// The request format option: a chat to WorkBuddy's China build can go out in
// the shape of the official CodeBuddy CLI 2.108.1 instead of WorkBuddy's own
// desktop app. What that shape is comes from durindoor v3.18.0's codebuddy-cn
// executor, whose request is the one checked against the gateway in
// production: this file pins the plugin against what that executor puts on
// the wire — nine headers and no more, and the body transform beside them.
// Rendered by running it, not read off its source, so the test and the
// capture stay the same thing.
//
// Nothing of the option reaches anything but a chat. /v1/messages and
// count_tokens are another API, whose headers no CodeBuddy capture
// describes; the product config, the meter and the check-in are not chats at
// all. WorkBuddy AI has the one format. And a value naming no format this
// plugin knows sends what every request sent before the option existed.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
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

// WHAT_2108 is the whole header surface 2.108.1's chat carries: what
// durindoor v3.18.0's executor puts on the wire, measured by running it, is
// exactly these nine and nothing else.
const WHAT_2108 = {
  accept: "text/event-stream",
  "content-type": "application/json",
  "user-agent": "CLI/2.108.1 CodeBuddy/2.108.1",
  "x-ide-type": "CLI",
  "x-ide-name": "CLI",
  "x-product": "SaaS",
  "x-codebuddy-request": "1",
  "x-requested-with": "XMLHttpRequest",
}

// NOT_2108 is everything else: the app's own headers (which sign() sets for
// the plugin's format and the 2.108.1 branch takes back off), the four
// conversation ids attendChat adds, the OpenAI SDK's X-Stainless-* set, and
// the headers later CLI releases began sending.
const NOT_2108 = [
  "x-user-id",
  "x-domain",
  "x-api-key",
  "x-enterprise-id",
  "x-tenant-id",
  "x-ide-version",
  "x-agent-intent",
  "x-agent-purpose",
  "x-private-data",
  "x-conversation-id",
  "x-conversation-message-id",
  "x-conversation-request-id",
  "x-request-id",
  "x-agent-type",
  "x-agent-runtime",
  "x-stainless-retry-count",
  "x-stainless-lang",
  "x-stainless-package-version",
  "x-stainless-os",
  "x-stainless-arch",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
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

test("a chat in 2.108.1's format is nine headers and no more", async () => {
  const { headers } = await chat({ body: send("hi"), options: FORMAT })
  const got = [...headers.keys()].sort()
  expect(got).toEqual([...Object.keys(WHAT_2108), "authorization"].sort())
  for (const [k, v] of Object.entries(WHAT_2108)) expect([k, headers.get(k)]).toEqual([k, v])
  for (const k of NOT_2108) expect([k, headers.get(k)]).toEqual([k, null])
})

test("the only headers the token adds are the bearer one", async () => {
  const { headers } = await chat({ body: send("hi"), options: FORMAT })
  expect(headers.get("authorization")).toBe("Bearer at")
})

test("an enterprise account says nothing extra: 2.108.1 carries no enterprise pair", async () => {
  const auth = { type: "oauth", access: "at", refresh: "r", uid: "u1", enterpriseId: "ent-9", expires: later() }
  const { headers } = await chat({ body: send("hi"), options: FORMAT, auth })
  expect([...headers.keys()].sort()).toEqual([...Object.keys(WHAT_2108), "authorization"].sort())
  expect(headers.get("x-enterprise-id")).toBe(null)
  expect(headers.get("x-private-data")).toBe(null)
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

// The body transform. durindoor's codebuddy-cn executor does four things and
// nothing else: stream:true always (registry forceStream plus
// `transformed.stream = true`, because the gateway answers 11101 to a
// non-stream request), a top-level reasoning_effort of "none"/"off" deleted
// outright, reasoning_summary:"auto" written beside any other effort, and
// stream_options:{include_usage:true} added when the client named none. It
// never writes verbosity.

test("a chat that asks for thinking keeps its effort and gains only the summary", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "high" }), options: FORMAT })
  const b = JSON.parse(body)
  expect([b.reasoning_effort, b.reasoning_summary]).toEqual(["high", "auto"])
  expect("verbosity" in b).toBe(false)
})

test("none is deleted, not sent: the gateway has no such effort", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "none" }), options: FORMAT })
  const b = JSON.parse(body)
  expect("reasoning_effort" in b).toBe(false)
  expect("reasoning_summary" in b).toBe(false)
  expect("verbosity" in b).toBe(false)
})

test("off is deleted too", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "off" }), options: FORMAT })
  const b = JSON.parse(body)
  expect("reasoning_effort" in b).toBe(false)
  expect("reasoning_summary" in b).toBe(false)
})

test("a nested reasoning:{effort} is not read, as durindoor does not read it", async () => {
  const { body } = await chat({ body: send("hi", { reasoning: { effort: "high" } }), options: FORMAT })
  const b = JSON.parse(body)
  expect(b.reasoning).toEqual({ effort: "high" })
  expect("reasoning_summary" in b).toBe(false)
})

test("a caller's summary is overwritten, and its verbosity passes through", async () => {
  const { body } = await chat({ body: send("hi", { reasoning_effort: "high", reasoning_summary: "concise", verbosity: "low" }), options: FORMAT })
  const b = JSON.parse(body)
  expect([b.reasoning_summary, b.verbosity]).toEqual(["auto", "low"])
})

test("the body is streamed whatever the client asked, and asks for its usage", async () => {
  for (const asked of [false, undefined]) {
    const { body } = await chat({ body: { ...send("hi"), stream: asked }, options: FORMAT })
    const b = JSON.parse(body)
    expect([asked, b.stream]).toEqual([asked, true])
    expect(b.stream_options).toEqual({ include_usage: true })
  }
})

test("a client's own stream_options is left as it wrote it", async () => {
  const { body } = await chat({ body: send("hi", { stream_options: { foo: 1 } }), options: FORMAT })
  expect(JSON.parse(body).stream_options).toEqual({ foo: 1 })
})

test("a gpt-5.x model takes max_completion_tokens, as durindoor's rename reads it", async () => {
  const { body } = await chat({ body: send("hi", { model: "gpt-5.5", max_completion_tokens: 50 }), options: FORMAT })
  const b = JSON.parse(body)
  expect([b.max_completion_tokens, b.max_tokens]).toEqual([50, undefined])
})

test("every other model takes max_tokens", async () => {
  const { body } = await chat({ body: send("hi", { max_completion_tokens: 50 }), options: FORMAT })
  const b = JSON.parse(body)
  expect([b.max_tokens, b.max_completion_tokens]).toEqual([50, undefined])
})

// A client that asked for the whole reply at once still gets one: the chat
// went out streamed, and the chunks are put back together for it.
test("a non-streaming client gets one chat.completion back", async () => {
  const sse = [
    'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","content":"he"}}]}',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"llo"}}]}',
    'data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"why"}}]}',
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}',
    "data: [DONE]",
    "",
  ].join("\n\n")
  serve({
    "/v2/chat/completions": () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  })
  const hooks = await WorkBuddyAuthPlugin({ client: {} }, FORMAT)
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "at", refresh: "r", uid: "u1", expires: later() }))
  const res = await l.fetch("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(send("hi", { stream: false })),
  })
  expect(res.headers.get("content-type")).toBe("application/json")
  const v = await res.json()
  expect(v.object).toBe("chat.completion")
  expect(v.id).toBe("c1")
  expect(v.usage).toEqual({ total_tokens: 3 })
  expect(v.choices[0].finish_reason).toBe("stop")
  expect(v.choices[0].message).toEqual({ role: "assistant", content: "hello", reasoning_content: "why" })
})

test("a streaming client still gets the stream", async () => {
  const { headers, calls } = await chat({ body: send("hi"), options: FORMAT })
  expect(headers.get("accept")).toBe("text/event-stream")
  expect(calls.at(-1).headers.get("accept")).toBe("text/event-stream")
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

test("magpie's own hint headers never leave: the vendor sees the CLI's request", async () => {
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: new URL(String(url)), headers: new Headers(init?.headers) })
    return STREAM()
  }
  const hooks = await WorkBuddyAuthPlugin({ client: {} }, FORMAT)
  const l = await hooks.auth.loader(async () => ({ type: "oauth", access: "at", refresh: "r", uid: "u1", expires: later() }))
  const res = await l.fetch("https://copilot.tencent.com/v2/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "magpie/1.4.2",
      "x-magpie-session": "sess-1",
      "x-magpie-agent": "deepseek-harness",
      "x-stainless-lang": "js",
      "x-tenant-id": "t1",
    },
    body: JSON.stringify(send("hi")),
  })
  await res.text()
  const got = [...sent.at(-1).headers.keys()].sort()
  expect(got).toEqual([...Object.keys(WHAT_2108), "authorization"].sort())
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

// The shape lives in codebuddy.mjs so that following upstream's index.mjs
// never has to merge past it. An install that left the file out would have a
// plugin that cannot import, so package.json has to ship it — as cursor's
// ships native-session.mjs.
test("the module the shape lives in is in the package's files", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"))
  expect(pkg.files).toContain("codebuddy.mjs")
  expect(existsSync(join(import.meta.dir, "codebuddy.mjs"))).toBe(true)
  expect(new Set(pkg.files).size).toBe(pkg.files.length)
})
