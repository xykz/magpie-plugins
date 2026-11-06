// The plugin's request against the desktop app's, value by value.
//
// `testdata/vendor-desktop-1.1.5.json` is not a capture: it is what the app's
// own bytecode printed when `helper/raccoon-vendor-fixture.mjs` executed it
// (openai's platform_headers, box_agent's ClientInfo.headers_for_url and
// _agent_headers, openai_client's _apply_thinking_params). So a failure here
// is not "the capture disagrees" — it is the plugin and the app disagreeing,
// which is the only thing this file is about.
//
// The app is read through one level of indirection: `vendor-wire.mjs` is the
// reproduction, this file checks it against the fixture. Regenerating the
// fixture needs CPython 3.12 and the app's zip, neither of which CI has, so
// the JSON is committed and `--check` is a local tool.
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import {
  KNOWN_DIVERGENCES,
  VENDOR,
  addStreamOptions,
  agentHeaders,
  clientIdentityHeaders,
  desktopPlatform,
  dispatchThinking,
  hostAcceptsIdentity,
  readOrgCode,
  stainlessArch,
  stainlessHeaders,
  stainlessOs,
  wireHeaders,
} from "./vendor-wire.mjs"

const fixture = JSON.parse(readFileSync(new URL("./testdata/vendor-desktop-1.1.5.json", import.meta.url), "utf8"))

// the fixture's host names, turned back into what process.platform says
const HOSTS = {
  "windows-x64": { platform: "win32", arch: "x64" },
  "windows-arm64": { platform: "win32", arch: "arm64" },
  "macos-arm64": { platform: "darwin", arch: "arm64" },
  "macos-x64": { platform: "darwin", arch: "x64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "linux-arm64": { platform: "linux", arch: "arm64" },
}

test("the fixture is the app this module reproduces", () => {
  expect(fixture.schema).toBe(1)
  expect(fixture.source.appVersion).toBe(VENDOR.appVersion)
  expect(fixture.source.appName).toBe(VENDOR.app)
  expect(fixture.source.openaiSdk).toBe(VENDOR.sdkVersion)
  expect(fixture.source.bundledPython).toBe(VENDOR.pythonVersion)
  expect(fixture.chatUrl).toBe("https://xiaohuanxiong.com/api/web/llm/v2/chat/completions")
})

test("the SDK headers match on every host the app ships for", () => {
  for (const [host, { platform, arch }] of Object.entries(HOSTS)) {
    expect({ host, headers: stainlessHeaders({ platform, arch }) }).toEqual({
      host,
      headers: fixture.headers.stainless[host],
    })
  }
})

test("a Windows x64 build names its arch other:amd64, as the SDK does", () => {
  // the one value nobody guesses right: platform.machine() says AMD64, which
  // get_architecture() maps to nothing, and OtherArch prints itself
  expect(stainlessArch("win32", "x64")).toBe("other:amd64")
  expect(stainlessArch("win32", "arm64")).toBe("arm64")
  expect(stainlessArch("darwin", "arm64")).toBe("arm64")
  expect(stainlessArch("darwin", "x64")).toBe("x64")
  expect(stainlessArch("linux", "x64")).toBe("x64")
  expect(stainlessArch("linux", "arm64")).toBe("arm64")
})

test("an unknown OS is spelled Other: with a capital O", () => {
  // OtherPlatform.__str__ is "Other:" where OtherArch is "other:" — read out of
  // the SDK rather than assumed, because the two spellings differ
  expect(stainlessOs("plan9")).toBe("Other:plan9")
  expect(stainlessOs("darwin")).toBe("MacOS")
  expect(stainlessOs("win32")).toBe("Windows")
  expect(stainlessOs("linux")).toBe("Linux")
})

test("the client identity matches on every host the app ships for", () => {
  for (const [host, { platform, arch }] of Object.entries(HOSTS)) {
    const expected = fixture.headers.clientInfo[host]
    const headers = clientIdentityHeaders({
      url: fixture.chatUrl,
      platform,
      arch,
      osVersion: expected["x-client-os-version"],
      version: VENDOR.appVersion,
    })
    expect({ host, headers }).toEqual({ host, headers: expected })
  }
})

test("the platform the identity names is not the one the SDK names", () => {
  expect(desktopPlatform("win32", "x64")).toBe("desktop-windows-x64")
  expect(stainlessArch("win32", "x64")).toBe("other:amd64")
})

test("no device id is sent, because the app has none to send", () => {
  const headers = clientIdentityHeaders({ url: fixture.chatUrl })
  expect(headers["x-client-device-id"]).toBeUndefined()
  expect(Object.keys(headers).length).toBe(5)
})

test("a version that is not three numbers costs the header and nothing else", () => {
  for (const version of ["1.1.5-beta", "1.1.5.0", "01.1.5"]) {
    const headers = clientIdentityHeaders({ url: fixture.chatUrl, version })
    expect({ version, has: "x-client-version" in headers }).toEqual({ version, has: false })
    // the other four still go: only the version is validated
    expect(Object.keys(headers).length).toBe(4)
  }
  expect(clientIdentityHeaders({ url: fixture.chatUrl, version: "1.1.5" })["x-client-version"]).toBe("v1.1.5")
})

test("a non-ASCII name falls back to raccoon rather than being mangled", () => {
  expect(clientIdentityHeaders({ url: fixture.chatUrl, name: "小浣熊" })["x-client-name"]).toBe("raccoon")
})

test("the identity goes to the vendor's own host, and to no other", () => {
  expect(hostAcceptsIdentity(fixture.chatUrl)).toBe(true)
  expect(hostAcceptsIdentity("https://xiaohuanxiong.com/")).toBe(true)
  expect(hostAcceptsIdentity("https://code-stage.xiaohuanxiong.com/api/web/llm/v2")).toBe(true)
  expect(hostAcceptsIdentity("https://example.com/api/web/llm/v2")).toBe(false)
  expect(hostAcceptsIdentity("https://xiaohuanxiong.com.evil.test/")).toBe(false)
  expect(hostAcceptsIdentity("not a url")).toBe(false)
  expect(clientIdentityHeaders({ url: "https://example.com/x" })).toEqual({})
})

test("RACCOON_CLIENT_HEADERS_HOSTS opens a relay without opening anything else", () => {
  const saved = process.env.RACCOON_CLIENT_HEADERS_HOSTS
  try {
    process.env.RACCOON_CLIENT_HEADERS_HOSTS = "relay.internal, 127.0.0.1 "
    expect(hostAcceptsIdentity("http://relay.internal:8080/v1/chat/completions")).toBe(true)
    expect(hostAcceptsIdentity("http://127.0.0.1:9/v1/chat/completions")).toBe(true)
    expect(hostAcceptsIdentity("http://localhost:9/v1/chat/completions")).toBe(false)
  } finally {
    if (saved === undefined) delete process.env.RACCOON_CLIENT_HEADERS_HOSTS
    else process.env.RACCOON_CLIENT_HEADERS_HOSTS = saved
  }
})

test("the turn headers match, and a blank one is not sent", () => {
  const agent = fixture.headers.agent
  const headers = agentHeaders({
    sessionId: agent["X-RACCOON-Session-ID"],
    turnId: agent["X-RACCOON-Turn-ID"],
    title: agent["X-RACCOON-Title"],
    callKind: agent["X-RACCOON-Call-Kind"],
  })
  expect(headers).toEqual(agent)

  expect(agentHeaders({ sessionId: "s", title: "  " })).toEqual({ "X-RACCOON-Session-ID": "s" })
  expect(agentHeaders({})).toEqual({})
})

test("an org code is sent for a team seat and never for a personal one", () => {
  expect(readOrgCode({ office_identity: "acme" })).toBe("acme")
  for (const personal of ["", "  ", "personal", "个人", undefined, 42]) {
    expect({ personal, code: readOrgCode({ office_identity: personal }) }).toEqual({ personal, code: "" })
  }
})

test("the thinking parameters match the app for every model it was measured on", () => {
  for (const [key, want] of Object.entries(fixture.thinking)) {
    for (const level of ["on", "off"]) {
      if (want[level] === undefined) continue
      const body = { model: key.replace(/\|tools$/, "") }
      if (key.endsWith("|tools")) body.tools = [{ type: "function", function: { name: "noop" } }]
      body.thinking = level === "on" ? "enabled" : "disabled"
      dispatchThinking(body)
      const seen = {}
      for (const field of ["extra_body", "enable_thinking", "reasoning_effort"]) {
        if (body[field] !== undefined) seen[field] = body[field]
      }
      expect({ key, level, seen }).toEqual({ key, level, seen: want[level] })
    }
  }
})

test("every divergence named is still real", () => {
  // The list is a claim about the code, so a claim that stops being true has
  // to be struck off here. Checked against vendor-wire.mjs rather than trusted:
  // each name is one this module knowingly does not reproduce. `connection` is
  // not on the list because it is set: whether a transport forwards it is the
  // transport's choice, not a divergence the plugin is choosing.
  const written = Object.keys(KNOWN_DIVERGENCES)
  for (const header of ["host", "content-length"]) {
    expect({ header, listed: written.includes(header) }).toEqual({ header, listed: true })
  }
  expect(written).not.toContain("connection")
})

test("the stream asks for usage the way the app's client does", () => {
  // _request_body_params: params.update(stream=True,
  // stream_options={'include_usage': True}) on every stream
  const body = { model: "sn-kimi-k3", stream: true }
  expect(addStreamOptions(body)).toBe(true)
  expect(body.stream_options).toEqual({ include_usage: true })
  // and not on a non-streaming call, which the app does not set it on either
  const plain = { model: "sn-kimi-k3", messages: [] }
  expect(addStreamOptions(plain)).toBe(false)
  expect(plain.stream_options).toBeUndefined()
})

test("wireHeaders reproduces the whole set against the vendor url", () => {
  const body = { model: "sn-kimi-k3", messages: [{ role: "user", content: "hi" }] }
  const headers = wireHeaders(new Headers({ Authorization: "Bearer t" }), {
    url: fixture.chatUrl,
    body,
  })
  const seen = Object.fromEntries(headers)
  // the six the SDK writes
  for (const [name, value] of Object.entries(fixture.headers.stainless["linux-x64"])) {
    if (name === "X-Stainless-Arch" || name === "X-Stainless-OS") continue
    expect({ name, value: seen[name.toLowerCase()] }).toEqual({ name, value })
  }
  // the five the app's ClientInfo writes, on this host
  const identity = seen["x-client-name"]
  expect(identity).toBe("@raccoon/office-desktop")
  expect(seen["x-client-channel"]).toBe("official")
  expect(seen["x-client-version"]).toBe("v1.1.5")
  // the turn headers, session derived from the conversation
  expect(seen["x-raccoon-session-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(seen["x-raccoon-turn-id"]).toMatch(/^[0-9a-f]{8}-/)
  // Call-Kind is not invented: the app's value comes from its caller
  expect(seen["x-raccoon-call-kind"]).toBeUndefined()
  // and the transport default the app never overrides
  expect(seen["accept-encoding"]).toBe("gzip, deflate")
  // the host's own header survives
  expect(seen.authorization).toBe("Bearer t")
})

test("wireHeaders has no session to name on a call that carries no conversation", () => {
  // a session id is derived from a conversation; a request with no body has
  // none, and a made-up one every call would be worse than the header's absence
  const headers = wireHeaders(new Headers(), { url: fixture.chatUrl })
  expect(headers.get("x-raccoon-session-id")).toBeNull()
  // the identity still goes: it does not depend on the conversation
  expect(headers.get("x-client-name")).toBe("@raccoon/office-desktop")
})

test("wireHeaders adds nothing off the vendor's host", () => {
  const before = new Headers({ Authorization: "Bearer t" })
  const headers = wireHeaders(before, { url: "https://example.com/v1/chat/completions" })
  const seen = Object.fromEntries(headers)
  expect(seen.authorization).toBe("Bearer t")
  expect(seen["x-client-name"]).toBeUndefined()
  expect(seen["x-stainless-lang"]).toBeUndefined()
  expect(seen["accept-encoding"]).toBeUndefined()
})
