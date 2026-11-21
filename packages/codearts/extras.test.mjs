// The fork's own piece: the request-shape switch. Run with: node --test
// packages/codearts/extras.test.mjs (bun test runs it too).
//
// Two things are checked here and nowhere else: that the switch is declared
// the way magpie draws an option, and that opening it moves the four points of
// the request that the IDE's agent kernel names differently — and nothing else.

import test from "node:test"
import assert from "node:assert/strict"

import { CodeArtsAuthPlugin, OfficeAceAuthPlugin, _internal as x, _officeace as oa } from "./index.mjs"
import { OA_WIRE_OPTION, OA_WIRE_SWITCH, WIRE_OPTION, WIRE_SWITCH, shapeOn, shapeReader, wireOn } from "./extras.mjs"

// The switch is read at each request from a reader the wrap registers, so a
// test that opens it has to put it back or the next one inherits it.
const shape = (on, provider = "codearts") => shapeReader(provider, () => on)
const signOfficeAceV11 = (...args) => oa.signOfficeAceV11(...args)
test.after(() => { shapeReader("codearts"); shapeReader("officeace") })

test("the switch is declared the way magpie draws an option", () => {
  const opt = WIRE_OPTION
  assert.equal(opt.key, WIRE_SWITCH)
  assert.notEqual(opt.default, true)
  // magpie truncates these silently (host.js's shown(v, 60) / shown(v, 300)):
  // a longer one loses its end with nothing to say so.
  assert.ok(opt.label.length <= 60, `label is ${opt.label.length}`)
  assert.ok(opt.description.length <= 300, `description is ${opt.description.length}`)
  for (const lang of ["zh", "zh-TW", "ja", "de"]) {
    assert.ok(opt.labels[lang], `${lang} label`)
    assert.ok(opt.descriptions[lang], `${lang} description`)
    assert.ok(opt.labels[lang].length <= 60, `${lang} label is ${opt.labels[lang].length}`)
    assert.ok(opt.descriptions[lang].length <= 300, `${lang} description is ${opt.descriptions[lang].length}`)
  }
})

test("wireOn reads magpie's option() for this provider's own key alone", () => {
  assert.equal(wireOn(undefined, "codearts"), false)
  assert.equal(wireOn({}, "codearts"), false)
  assert.equal(wireOn({ option: () => false }, "codearts"), false)
  assert.equal(wireOn({ option: (p, k) => p === "codearts" && k === WIRE_SWITCH }, "codearts"), true)
  // a switch of another provider's does not reach this one
  assert.equal(wireOn({ option: (p) => p === "officeace" }, "codearts"), false)
  assert.equal(wireOn({ option: (p) => p === "trae-cn" }, "codearts"), false)
  // nor does this package's other card's key: `option()` is asked
  // (provider, key), and both cards live here
  assert.equal(wireOn({ option: (p, k) => k === OA_WIRE_SWITCH }, "codearts"), false)
  assert.equal(wireOn({ option: (p, k) => k === WIRE_SWITCH }, "officeace"), false)
  assert.equal(wireOn({ option: (p, k) => k === OA_WIRE_SWITCH }, "officeace"), true)
  // a host that throws is a host that said no
  assert.equal(wireOn({ option: () => { throw new Error("no") } }, "codearts"), false)
})

test("no reader is off: OpenCode keeps upstream's shape", () => {
  shapeReader("codearts")
  assert.equal(shapeOn(), false)
  // and a reader that throws reads the same way
  shapeReader("codearts", () => { throw new Error("no") })
  assert.equal(shapeOn(), false)
})

test("the plugin's card carries the switch, and the sign-in methods survive the wrap", async () => {
  process.env.MAGPIE_CODEARTS_IDE_STATE = "/nonexistent/state.vscdb"
  const plugin = await CodeArtsAuthPlugin({ client: {} })
  assert.deepEqual(plugin.auth.options.map((o) => o.key), [WIRE_SWITCH])
  // `methods` is a getter on the auth the base returns: spread would have
  // called it and frozen one answer for good
  const methods = plugin.auth.methods
  assert.ok(Array.isArray(methods) && methods.length >= 1)
  assert.equal(typeof methods[0].authorize, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.provider)
})

test("thinking: the kernel's two booleans instead of the plugin's object", () => {
  const spec = (body) => {
    const out = x.prepareChatBody({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], ...body }, {})
    return out.body
  }
  shape(false)
  // upstream: one `thinking` object, injected when the caller said nothing
  assert.deepEqual(spec({}).thinking, { type: "enabled" })
  assert.deepEqual(spec({ reasoning_effort: "none" }).thinking, { type: "disabled" })
  assert.deepEqual(spec({ thinking: { type: "disabled" } }).thinking, { type: "disabled" })
  assert.equal(spec({}).enable_thinking, undefined)

  shape(true)
  const on = spec({})
  assert.equal(on.thinking, undefined)
  assert.equal(on.enable_thinking, true)
  assert.equal(on.tool_stream, true)
  assert.deepEqual(on.stream_options, { include_usage: true })
  // the caller's own object means the same thing, said the kernel's way
  assert.equal(spec({ thinking: { type: "disabled" } }).enable_thinking, false)
  assert.equal(spec({ thinking: { type: "enabled" } }).enable_thinking, true)
  // a level of "no thinking" is the same boolean
  assert.equal(spec({ reasoning_effort: "none" }).enable_thinking, false)
  // and the kernel says both things whatever the thinking is
  assert.equal(spec({ reasoning_effort: "none" }).tool_stream, true)
  shape(false)
})

test("the signed set carries no content hash when the kernel's shape is on", async () => {
  const ak = "AK", sk = "SK", token = "TOKEN"
  const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions"
  const body = new TextEncoder().encode("{}")
  const signedFor = async (omit) => {
    const map = await x.signRequestHuawei(ak, sk, token, "POST", url, body, undefined, undefined, omit)
    return map
  }
  // The signer takes it as an argument, not from the switch: the plugin's own
  // routes (IAM, opengw, the benefit claim) are not the kernel's and keep
  // their content hash whatever the switch says.
  const upstream = await signedFor(false)
  assert.ok(upstream.has("x-sdk-content-sha256"))
  assert.match(upstream.get("Authorization"), /x-sdk-content-sha256/)

  const kernel = await signedFor(true)
  // out of the headers *and* out of SignedHeaders: one without the other is a
  // signature the gateway refuses
  assert.equal(kernel.has("x-sdk-content-sha256"), false)
  assert.doesNotMatch(kernel.get("Authorization"), /x-sdk-content-sha256/)
  // everything else is signed the same way
  assert.match(kernel.get("Authorization"), /host;x-sdk-date;x-security-token/)
  assert.equal(kernel.get("x-security-token"), token)
  assert.equal(kernel.get("x-sdk-date"), upstream.get("x-sdk-date"))
  // the default is the upstream signature: a caller that says nothing is not
  // silently moved
  const byDefault = await signedFor(undefined)
  assert.ok(byDefault.has("x-sdk-content-sha256"))
})

test("OfficeAce carries its own switch, and the two do not reach each other", async () => {
  const plugin = await OfficeAceAuthPlugin({ client: {} })
  assert.deepEqual(plugin.auth.options.map((o) => o.key), [OA_WIRE_SWITCH])
  // the two providers are separate cards: one switch on, the other untouched
  shapeReader("codearts", () => true)
  assert.equal(shapeOn("codearts"), true)
  assert.equal(shapeOn("officeace"), false)
  shapeReader("officeace", () => true)
  assert.equal(shapeOn("codearts"), true)
  // and the switch has to fit what magpie draws
  const opt = OA_WIRE_OPTION
  assert.equal(opt.key, OA_WIRE_SWITCH)
  assert.notEqual(opt.default, true)
  assert.ok(opt.label.length <= 60, `label is ${opt.label.length}`)
  assert.ok(opt.description.length <= 300, `description is ${opt.description.length}`)
  for (const lang of ["zh", "zh-TW", "ja", "de"]) {
    assert.ok(opt.labels[lang], `${lang} label`)
    assert.ok(opt.descriptions[lang], `${lang} description`)
    assert.ok(opt.labels[lang].length <= 60, `${lang} label is ${opt.labels[lang].length}`)
    assert.ok(opt.descriptions[lang].length <= 300, `${lang} description is ${opt.descriptions[lang].length}`)
  }
})

test("the OfficeAce switch takes x-subscription-type off the claim's signature alone", () => {
  const cred = { access_key_id: "AK", secret_access_key: "SK", security_token: "TOKEN", project_id: "P" }
  const url = "https://officeace.example.com/v1/subscription/bonus/claim"
  const read = "https://officeace.example.com/v1/subscription"

  shape(false, "officeace")
  const offClaim = signOfficeAceV11(url, cred, "POST", undefined)
  assert.ok(offClaim["x-subscription-type"], "upstream signs it on POST")
  assert.match(offClaim.Authorization, /x-subscription-type/)

  shape(true, "officeace")
  const onClaim = signOfficeAceV11(url, cred, "POST", undefined)
  assert.equal(onClaim["x-subscription-type"], undefined)
  assert.doesNotMatch(onClaim.Authorization, /x-subscription-type/)
  assert.match(onClaim.Authorization, /content-type;host;x-project-id;x-sdk-date;x-security-token/)

  // the read side keeps it either way
  for (const on of [true, false]) {
    shape(on, "officeace")
    const got = signOfficeAceV11(read, cred, "GET", undefined)
    assert.equal(got["x-subscription-type"], "v2", `GET with switch ${String(on)}`)
    assert.match(got.Authorization, /x-subscription-type/)
  }
})

test("a refused model catalog reads as a stale MaaS pair, not a dead sign-in", async () => {
  // The catalog is signed with the MaaS Basic pair, which is derived from the
  // sign-in rather than being it. With the switch on, a 401 there must not
  // report the account as signed out: the pair is re-read once, the catalog is
  // asked again, and the card stays signed in either way.
  const payload = Buffer.from(JSON.stringify({ user_profile: JSON.stringify({ account_id: "DOM1" }) })).toString("base64url")
  const cred = {
    access_key_id: "AK", secret_access_key: "SK", security_token: "ST",
    expires_at: "2030-01-01T00:00:00Z", refresh_token: `h.${payload}.s`,
    code_verifier: "CV", dpop_private_key_jwk: { kty: "EC" }, session_id: "SESS",
    model_app_key: "OLDK", model_app_secret: "OLDS", domain_id: "DOM1",
  }
  const record = {
    type: "oauth", refresh: cred.refresh_token,
    access: JSON.stringify(oa.officeAceCredentialRecord(cred)),
    expires: Date.now() + 3600e3, accountId: "DOM1", uid: "DOM1",
  }
  const magpie = (on) => ({ option: (provider, key) => on && provider === "officeace" && key === OA_WIRE_SWITCH })

  /** The old pair is refused by the market host, a freshly minted one is not. */
  const drive = async (on) => {
    const hits = []
    const fetcher = async (url) => {
      const u = String(url)
      hits.push(u.replace(/^https?:\/\//, "").split("?")[0])
      if (u.includes("client-permission-validate")) {
        return Response.json({ subscription: { model_info: {
          model_auth_info: { model_app_key: "NEWK", model_app_secret: "NEWS" },
          model_api_url_base: "https://maas.example",
        } } })
      }
      if (u.includes("/v2/models")) {
        if (u.startsWith("https://api.modelarts-maas.com")) return new Response("denied", { status: 401 })
        return Response.json({ data: [{ id: "deepseek-v4.1-flash" }] })
      }
      if (u.includes("model-token-rates")) return Response.json({ models: [{ name: "deepseek-v4.1-flash", cost_coefficient: 1 }] })
      return Response.json({})
    }
    const client = { auth: { set: async () => {}, get: async () => record }, app: { log() {} } }
    const plugin = await OfficeAceAuthPlugin({ client, magpie: magpie(on) }, { fetch: fetcher })
    try {
      return { rows: Object.keys(await plugin.provider.models({ models: { static_a: {} } }, { auth: record })), hits }
    } catch (e) {
      return { error: e, hits }
    }
  }

  // off is upstream's reading: a refused catalog means the sign-in is dead
  const off = await drive(false)
  assert.equal(off.error?.signIn, "expired")
  assert.match(off.error.message, /登录已失效/)

  // on is the client's: the pair is re-read, the catalog answers, nobody is
  // signed out, and the account's own model list survives
  const on = await drive(true)
  assert.equal(on.error, undefined)
  assert.deepEqual(on.rows, ["deepseek-v4.1-flash"])
  assert.ok(on.hits.some((h) => h.includes("client-permission-validate")), "the pair is re-read")
  assert.equal(on.hits.filter((h) => h.includes("/v2/models")).length, 2, "the catalog is asked twice")

  // and when the re-read yields nothing, the static table stands rather than a
  // sign-out
  const refusing = await OfficeAceAuthPlugin(
    {
      client: { auth: { set: async () => {}, get: async () => record }, app: { log() {} } },
      magpie: magpie(true),
    },
    { fetch: async (url) => (String(url).includes("client-permission-validate")
      ? new Response("nope", { status: 401 })
      : new Response("denied", { status: 401 })) },
  )
  assert.deepEqual(
    Object.keys(await refusing.provider.models({ models: { static_a: {} } }, { auth: record })),
    ["static_a"],
  )
})
