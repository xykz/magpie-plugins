// The fork's own piece: the request-shape switch.
//
// Kept apart (like raccoon's and loomy's extras.mjs) so that merging upstream's
// index.mjs has to keep only a handful of marked call sites — this import, the
// gate inside chatBody, and the wrap at the bottom — and not this file. Nothing
// here runs unless index.mjs asks for it.

// ── the switch ─────────────────────────────────────────────────────────────
//
// A chat can go out in two shapes:
//
//   off (default)  what upstream's plugin sends
//   on             what the TRAE SOLO CN client (0.1.69) sends
//
// The two differ in one place: the client names the conversation twice, in
// `session_id` and in `conversation_id`, and says how the request reaches the
// model in `access_type`; upstream sends `session_id` alone. Trae counts a
// conversation by what it is given, so both halves are written from the one
// id — see index.mjs's chatBody, where the gate is.
//
// One switch, off by default, the same shape as workbuddy's
// request_format_2108 and raccoon's request_shape_desktop_1_1_5, so a user of
// this fork meets one kind of switch in every plugin.
export const WIRE_SWITCH = "request_shape_client_0_1_69"

// The shapes there are, newest first: the newest one on sends, since magpie
// hands a plugin nothing when a switch changes. A second shape to add later is
// one more entry here.
export const WIRE_SWITCHES = [{ key: WIRE_SWITCH }]

/**
 * Whether a chat to `provider` goes out in the client's shape, as the switch
 * says now. `magpie` is what the host handed the plugin at load.
 */
export function wireOn(magpie, provider) {
  try {
    return WIRE_SWITCHES.some((f) => magpie?.option?.(provider, f.key) === true)
  } catch {
    return false
  }
}

/** The switch as the editor draws it. */
export const WIRE_OPTION = {
  key: WIRE_SWITCH,
  label: "Send as the TRAE SOLO CN client 0.1.69",
  description:
    "Names the conversation in conversation_id beside session_id, and says in access_type how the request reaches the model, the way TRAE SOLO CN's own client does — instead of session_id alone. Off sends upstream's request. Both sign in as the same account and read the same endpoint.",
  labels: {
    zh: "按 TRAE SOLO CN 客户端 0.1.69 发送",
    "zh-TW": "以 TRAE SOLO CN 用戶端 0.1.69 送出",
    ja: "TRAE SOLO CN クライアント 0.1.69 として送信",
    de: "Als TRAE-SOLO-CN-Client 0.1.69 senden",
  },
  descriptions: {
    zh: "在 session_id 之外用 conversation_id 再写一次会话，并用 access_type 说明这个请求怎么到达模型 — 与 TRAE SOLO CN 自己的客户端一样；而不是只写 session_id。关闭时按上游的形状发送。两者登录同一个账号、读同一个端点。",
    "zh-TW": "在 session_id 之外用 conversation_id 再寫一次會話，並用 access_type 說明這個請求怎麼到達模型 — 與 TRAE SOLO CN 自己的用戶端一樣；而不是只寫 session_id。關閉時以上游的形狀送出。兩者登入同一個帳號、讀同一個端點。",
    ja: "session_id に加えて conversation_id でも会話を示し、access_type でリクエストがモデルにどう届くかを伝えます — TRAE SOLO CN 自身のクライアントと同じく、session_id のみではありません。オフのときは上流の形式です。どちらも同じアカウントで同じエンドポイントです。",
    de: "Nennt die Unterhaltung zusätzlich zu session_id auch in conversation_id und sagt in access_type, wie die Anfrage das Modell erreicht — wie der Client von TRAE SOLO CN selbst, statt nur session_id. Aus sendet das Upstream-Format. Beide nutzen dasselbe Konto und denselben Endpunkt.",
  },
}

// The switch is read at each request rather than caught once when the plugin
// loads: magpie hands its args over at load, and a user can change the options
// after. index.mjs registers the reading (extendTrae below). With none —
// OpenCode, or a plugin a test built — no request goes out in the client's
// shape, so what upstream sends is what is sent.
let reader = null

/** Register how the switch is read. */
export function shapeReader(fn) {
  reader = typeof fn === "function" ? fn : null
}

/** Whether a request goes out in the client's shape. */
export function shapeOn() {
  if (!reader) return false
  try {
    return reader() === true
  } catch {
    return false
  }
}

/**
 * What the client's shape adds to a chat body beside the id it already has.
 * `session` is the request's own conversation id — the one chatBody would send
 * as `session_id` — so the two names are one conversation, not two.
 */
export function clientShape(session) {
  return { conversation_id: session, access_type: 0 }
}

// ── the wrap ───────────────────────────────────────────────────────────────

/**
 * Wrap the plugin: its card gets the switch, and the gate inside index.mjs
 * reads `shapeOn()`.
 *
 * `deps.wire` is how the switch is read at a request; left out, the reader is
 * cleared and every request keeps upstream's shape.
 */
export function extendTrae(plugin, deps = {}) {
  if (!plugin?.auth) return plugin
  const out = { ...plugin, auth: { ...plugin.auth } }
  out.auth.options = [...(out.auth.options ?? []), WIRE_OPTION]
  shapeReader(deps.wire)
  return out
}
