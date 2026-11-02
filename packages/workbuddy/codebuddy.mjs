// The "codebuddy-2108" chat shape: the request durindoor v3.18.0's
// codebuddy-cn executor puts on the wire, which is the one checked against
// copilot.tencent.com in production. Everything that shape is — the nine
// headers, the body transform, whether a body goes gzipped, and the
// reassembly of a stream for a client that asked for none — lives here, so
// index.mjs only calls in and never carries a piece of it: headersOn(),
// bodyOn(), streamed(), gzipOn() and whole(). None of these read plugin
// state, and none of them is reached by any other format.
//
// The reason it is a file of its own: following the upstream plugin means
// merging packages/workbuddy/index.mjs over and over, and this format is
// not upstream's — nothing here may sit in that file's way.
import { randomBytes } from "node:crypto"

export const FORMAT_KEY = "requestFormat"
export const FORMAT_MAGPIE = "magpie"
export const FORMAT_2108 = "codebuddy-2108"
export const FORMATS = new Set([FORMAT_MAGPIE, FORMAT_2108])

const hex = () => randomBytes(16).toString("hex")

// What 2.108.1 says it is. Its User-Agent is buildUserAgent()'s shape with
// the CLI's own version in both halves. 2.108.1 is the release to mirror
// because it is the one durindoor v3.18.0 runs, and that request is the one
// checked against the gateway in production; its chat is nine headers and no
// more.
export const CB_VERSION = "2.108.1"
export const CB_UA = `CLI/${CB_VERSION} CodeBuddy/${CB_VERSION}`

// GPT_MAX is the model families that take max_completion_tokens rather than
// max_tokens, as durindoor's own translator reads them (paramSupport.js
// MAX_TOKENS_UNSUPPORTED_MODEL): the reasoning families o1/o3/o4 and the
// whole gpt-5.x line. Anchored at a prefix boundary and a version boundary,
// so `gpt-5.5` matches and `gpt-50` does not.
const GPT_MAX = /(?:^|[/:-])(?:o[134]|gpt-5(?:\.\d+)?)(?:[.-]|$)/i

// headersOn writes the whole header set of a 2108 chat from nothing. The
// clear first is the point: whatever the host put on the request (its own
// x-magpie-* hints, an SDK's x-stainless-*, the app's sign-in headers) is
// not part of the request this format copies, and a header nobody here
// writes cannot leak into it. The session header was read before this runs
// (sessionOf in index.mjs), so nothing the plugin does with it is lost.
export function headersOn(headers, access) {
  for (const k of [...headers.keys()]) headers.delete(k)
  headers.set("Authorization", "Bearer " + access)
  headers.set("Accept", "text/event-stream")
  headers.set("Content-Type", "application/json")
  headers.set("User-Agent", CB_UA)
  headers.set("X-IDE-Type", "CLI")
  headers.set("X-IDE-Name", "CLI")
  headers.set("X-Product", "SaaS")
  headers.set("x-codebuddy-request", "1")
  headers.set("X-Requested-With", "XMLHttpRequest")
}

// bodyOn applies the executor's four rules and reports whether it changed
// anything. Its effort reading is the top-level field alone, so a chat that
// spells it `reasoning: {effort}` gains nothing here, as there. It never
// writes verbosity: the executor does not, and verbosity is not a field the
// gateway's own requests carry.
export function bodyOn(chat) {
  let changed = false
  const eff = chat.reasoning_effort
  if (eff === "none" || eff === "off") {
    // the gateway has no none — it is omitted, not sent as one
    delete chat.reasoning_effort
    changed = true
  } else if (eff) {
    // written beside any effort, overwriting a caller's own
    chat.reasoning_summary = "auto"
    changed = true
  }
  if (chat.stream_options === undefined) {
    chat.stream_options = { include_usage: true }
    changed = true
  }
  // the one field rename durindoor leaves to its translator, and it runs
  // either way by model alone (applyParamRenames). The plugin's own rename
  // (systemOn) went the second way already.
  if (GPT_MAX.test(chat.model) && chat.max_tokens !== undefined) {
    if (chat.max_completion_tokens === undefined) chat.max_completion_tokens = chat.max_tokens
    delete chat.max_tokens
    changed = true
  }
  return changed
}

// streamed forces the body out streamed (the gateway answers 11101 to a
// non-stream chat) and returns whether the client wanted the stream it
// asked for. One that did not still gets the whole reply: whole() below
// puts the chunks back together for it.
export function streamed(chat) {
  const asked = chat.stream === true
  if (!asked) chat.stream = true
  return asked
}

// gzipOn is how the body goes on the wire: 2.108.1 sends plain JSON — no
// CodeBuddy capture carries a Content-Encoding — while the plugin's own
// format gzips. The zipping itself stays with the caller, so this module
// holds no compression of its own.
export function gzipOn(fmt, completion, b, zip) {
  return fmt === FORMAT_2108 ? null : zip(completion, b)
}

// whole answers a client that asked for no stream with the whole reply,
// turning the SSE that comes back into the one chat.completion it wanted.
// The fields are the ones magpie's gateway reads: text and
// reasoning_content joined, tool calls put back in index order,
// finish_reason and usage from the stream's last chunks.
export async function whole(res, model) {
  if (!res.body || !/event-stream/i.test(res.headers.get("content-type") ?? "")) return res
  const msg = { role: "assistant", content: "" }
  const calls = []
  let finish = "stop"
  let usage
  let id
  let created
  let served
  let failed = null
  for (const line of (await res.text()).split("\n")) {
    const m = /^data:\s?(.*)$/.exec(line.trim())
    if (!m || m[1] === "[DONE]") continue
    let v
    try {
      v = JSON.parse(m[1])
    } catch {
      continue
    }
    if (v?.error) {
      failed = v.error
      break
    }
    if (v?.id) id = v.id
    if (v?.created) created = v.created
    if (v?.model) served = v.model
    if (v?.usage) usage = v.usage
    const c = v?.choices?.[0]
    if (!c) continue
    const d = c.delta ?? c.message ?? {}
    if (typeof d.content === "string" && d.content) msg.content += d.content
    const r = typeof d.reasoning_content === "string" ? d.reasoning_content : d.reasoning
    if (typeof r === "string" && r) msg.reasoning_content = (msg.reasoning_content ?? "") + r
    for (const t of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      const at = Number.isSafeInteger(t?.index) ? t.index : calls.length
      calls[at] ??= { id: "", type: "function", function: { name: "", arguments: "" } }
      if (t?.id) calls[at].id = t.id
      if (t?.function?.name) calls[at].function.name = t.function.name
      if (typeof t?.function?.arguments === "string") calls[at].function.arguments += t.function.arguments
    }
    if (c.finish_reason) finish = c.finish_reason
  }
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  headers.set("content-type", "application/json")
  if (failed) {
    const status = Number(failed.status)
    return new Response(JSON.stringify({ error: failed }), { status: status >= 400 && status < 600 ? status : 502, headers })
  }
  if (calls.length) msg.tool_calls = calls.map((c, i) => ({ ...c, id: c.id || `call_${i}` }))
  const out = {
    id: id ?? "chatcmpl-" + hex(),
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: served ?? model,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
  }
  if (usage) out.usage = usage
  return new Response(JSON.stringify(out), { status: res.status, statusText: res.statusText, headers })
}
