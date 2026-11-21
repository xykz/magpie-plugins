// The fork's own piece: the request-shape switch. Run with: node --test
// packages/trae/extras.test.mjs (bun test runs it too).
//
// The switch turns on one thing only — the client naming its conversation
// twice — so that is what is checked: the option is drawn the way magpie draws
// one, and the second name is the same id as the first, not a new one.

import test from "node:test"
import assert from "node:assert/strict"

import { TraeCNAuthPlugin, _internal as x } from "./index.mjs"
import { WIRE_OPTION, WIRE_SWITCH, shapeOn, shapeReader, wireOn } from "./extras.mjs"

// The switch is read at each request from a reader the wrap registers, so a
// test that opens it has to put it back or the next one inherits it.
const shape = (on) => shapeReader(() => on)
test.after(() => shapeReader(null))

const ask = (model = "deepseek-v4.1-flash", session = "SESS-1") =>
  x.chatBody({ model, messages: [{ role: "user", content: "hi" }] }, "solo_agent", "", 0, null, session)

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

test("wireOn reads magpie's option() for this realm's own key alone", () => {
  assert.equal(wireOn(undefined, "trae-cn"), false)
  assert.equal(wireOn({}, "trae-cn"), false)
  assert.equal(wireOn({ option: () => false }, "trae-cn"), false)
  assert.equal(wireOn({ option: (p, k) => p === "trae-cn" && k === WIRE_SWITCH }, "trae-cn"), true)
  // the Global realm's switch is not this one's
  assert.equal(wireOn({ option: (p) => p === "trae-global" }, "trae-cn"), false)
  assert.equal(wireOn({ option: () => { throw new Error("no") } }, "trae-cn"), false)
})

test("no reader is off: OpenCode keeps upstream's shape", () => {
  shapeReader(null)
  assert.equal(shapeOn(), false)
  shapeReader(() => { throw new Error("no") })
  assert.equal(shapeOn(), false)
})

test("both realms' cards carry the switch, and their hooks survive the wrap", async () => {
  for (const [make, id] of [[TraeCNAuthPlugin, "trae-cn"], [await import("./index.mjs").then((m) => m.TraeGlobalAuthPlugin), "trae-global"]]) {
    const plugin = await make({ client: {} })
    assert.deepEqual(plugin.auth.options.map((o) => o.key), [WIRE_SWITCH])
    assert.equal(plugin.auth.provider, id)
    assert.equal(typeof plugin.auth.loader, "function")
    assert.equal(typeof plugin.auth.checkin, "function")
    assert.equal(typeof plugin.auth.usage, "function")
    assert.equal(typeof plugin.auth.refresh, "function")
    assert.equal(typeof plugin.config, "function")
    assert.ok(plugin.provider)
  }
})

test("the client's shape names the conversation twice, with one id", () => {
  shape(false)
  const off = ask()
  assert.equal(off.session_id, "SESS-1")
  assert.equal(off.conversation_id, undefined)
  assert.equal(off.access_type, undefined)

  shape(true)
  const on = ask()
  // one conversation, named twice — not two
  assert.equal(on.session_id, "SESS-1")
  assert.equal(on.conversation_id, on.session_id)
  assert.equal(on.access_type, 0)
  // and nothing else about the request moved
  const { conversation_id: _c, access_type: _a, request_id: _r, ...rest } = on
  const { request_id: _r2, ...restOff } = off
  assert.deepEqual(rest, restOff)
  shape(false)
})

test("with no session to name, both names still carry the same fresh id", () => {
  shape(true)
  const a = ask("deepseek-v4.1-flash", "")
  const b = ask("deepseek-v4.1-flash", "")
  assert.equal(a.conversation_id, a.session_id)
  assert.notEqual(a.session_id, b.session_id)
  assert.equal(a.access_type, 0)
  shape(false)
})
