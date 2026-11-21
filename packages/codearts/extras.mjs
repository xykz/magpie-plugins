// The fork's own piece: the request-shape switch.
//
// Kept apart (like raccoon's and loomy's extras.mjs) so that merging upstream's
// index.mjs has to keep only a handful of marked call sites — this import, the
// three gates inside it, and the wrap at the bottom — and not this file. Nothing
// here runs unless index.mjs asks for it.

// ── the switches ───────────────────────────────────────────────────────────
//
// The package has two providers with a card each, so it has two switches:
//
//   request_shape_ide_0_2_9       (codearts)  chats
//   request_shape_officeace_1_8_1 (officeace) the daily claim's signature
//
// `codearts`, off (default) → on: what upstream's plugin sends → what the agent
// kernel inside the CodeArts IDE (0.2.9) sends. The two differ in six places,
// all of them readings of the same account on the same host:
//
//   * the thinking is asked for with the kernel's two booleans
//     (`enable_thinking`, `tool_stream`) rather than a `thinking` object;
//   * no `Chat-Id`/`Session-Id` travel with the request (the kernel names its
//     session in `x-ot-session-id` alone);
//   * the signed set carries no `x-sdk-content-sha256`;
//   * `stream_options` asks the gateway to count the tokens;
//   * `x-ot-parent-session-id` repeats the session rather than being empty;
//   * `x-auth-token` carries the STS token a second time.
//
// `officeace`, off → on: the claim stops signing (and sending)
// `x-subscription-type` — the client signs that header on reads only.
//
// Off by default, the same shape as workbuddy's request_format_2108 and
// raccoon's request_shape_desktop_1_1_5, so a user of this fork meets one kind
// of switch in every plugin.
export const WIRE_SWITCH = "request_shape_ide_0_2_9"

// `officeace` is a provider of this package with a card of its own, so it gets a
// switch of its own rather than sharing `codearts`' — a user may want the
// kernel's chat shape on CodeArts while leaving OfficeAce exactly as upstream
// sends it, and one option cannot say that.
export const OA_WIRE_SWITCH = "request_shape_officeace_1_8_1"

// The shapes there are, newest first: the newest one on sends, since magpie
// hands a plugin nothing when a switch changes. A second shape to add later is
// one more entry here.
//
// Each entry names its provider: this package has two cards, and `option()` is
// asked `(provider, key)`, so an unbound list would let either card's switch
// turn the other's requests on.
export const WIRE_SWITCHES = [
  { provider: "codearts", key: WIRE_SWITCH },
  { provider: "officeace", key: OA_WIRE_SWITCH },
]

/**
 * Whether a request to `provider` goes out in the client's shape, as the switch
 * says now. `magpie` is what the host handed the plugin at load.
 */
export function wireOn(magpie, provider) {
  try {
    return WIRE_SWITCHES.some((f) => f.provider === provider && magpie?.option?.(provider, f.key) === true)
  } catch {
    return false
  }
}

/** The switch as the editor draws it. */
export const WIRE_OPTION = {
  key: WIRE_SWITCH,
  label: "Send as the CodeArts IDE 0.2.9 agent",
  description:
    "Sends chats the way the agent kernel inside the CodeArts IDE does — thinking as its two booleans, no Chat-Id or Session-Id, no content hash in the signature, and stream_options — not the way upstream sends them. Off sends upstream's request. Both sign in as the same account.",
  labels: {
    zh: "按 CodeArts IDE 0.2.9 的 agent 发送",
    "zh-TW": "以 CodeArts IDE 0.2.9 的 agent 送出",
    ja: "CodeArts IDE 0.2.9 の agent として送信",
    de: "Als CodeArts-IDE-0.2.9-Agent senden",
  },
  descriptions: {
    zh: "按 CodeArts IDE 里那个 agent 内核的请求形状发送 — 思考用它的两个布尔、不带 Chat-Id 与 Session-Id、签名里不含内容哈希、带 stream_options — 而不是上游的形状。关闭时按上游的形状发送。两者登录同一个账号。",
    "zh-TW": "以 CodeArts IDE 內那個 agent 內核的請求形狀送出 — 思考用它的兩個布林、不帶 Chat-Id 與 Session-Id、簽章裡不含內容雜湊、帶 stream_options — 而不是上游的形狀。關閉時以上游的形狀送出。兩者登入同一個帳號。",
    ja: "CodeArts IDE 内の agent カーネルの形式で送信します — 思考はその 2 つのブール値、Chat-Id と Session-Id なし、署名に content hash を含めない、stream_options。オフのときは上流の形式です。どちらも同じアカウントです。",
    de: "Sendet Chats im Format des Agent-Kernels der CodeArts IDE — Thinking als zwei Booleans, ohne Chat-Id und Session-Id, ohne Content-Hash in der Signatur, mit stream_options. Aus sendet das Upstream-Format. Beide nutzen dasselbe Konto.",
  },
}

// The OfficeAce card's switch, drawn beside the other one.
export const OA_WIRE_OPTION = {
  key: OA_WIRE_SWITCH,
  label: "Sign the daily claim the way OfficeAce 1.8.1 does",
  description:
    "Leaves x-subscription-type off the daily check-in claim, signed and sent, as the OfficeAce 1.8.1 client does — it signs that header on reads only. Off signs it as upstream does. Both claim the same account's points.",
  labels: {
    zh: "按 OfficeAce 1.8.1 的方式签署每日领取",
    "zh-TW": "以 OfficeAce 1.8.1 的方式簽署每日領取",
    ja: "OfficeAce 1.8.1 と同じ方法で毎日の受け取りに署名",
    de: "Den täglichen Anspruch wie OfficeAce 1.8.1 signieren",
  },
  descriptions: {
    zh: "每日领取签到时不再签名、也不再发送 x-subscription-type，与 OfficeAce 1.8.1 客户端一致 — 它只在读取侧签这个头。关闭时按上游签名。两者领取同一个账号的积分。",
    "zh-TW": "每日領取簽到時不再簽章、也不再送出 x-subscription-type，與 OfficeAce 1.8.1 用戶端一致 — 它只在讀取側簽這個標頭。關閉時按上游簽章。兩者領取同一個帳號的點數。",
    ja: "毎日の受け取り時に x-subscription-type を署名も送信もしません — OfficeAce 1.8.1 クライアントは読み取り側でのみこのヘッダーに署名します。オフのときは上流の署名です。どちらも同じアカウントのポイントを受け取ります。",
    de: "Signiert und sendet x-subscription-type beim täglichen Anspruch nicht mehr, wie der OfficeAce-1.8.1-Client, der diesen Header nur beim Lesen signiert. Aus signiert wie das Upstream. Beide holen die Punkte desselben Kontos.",
  },
}

// The switches are read at each request rather than caught once when the plugin
// loads: magpie hands its args over at load, and a user can change the options
// after. index.mjs registers the reading (extendCodeArts / extendOfficeAce
// below). With none — OpenCode, or a plugin a test built — no request goes out
// in the client's shape, so what upstream sends is what is sent.
//
// Keyed by provider: `codearts` and `officeace` are two cards, and one card's
// switch must not reach the other's requests.
const readers = new Map()

/** Register how one provider's switch is read. */
export function shapeReader(provider, fn) {
  if (typeof fn === "function") readers.set(provider, fn)
  else readers.delete(provider)
}

/** Whether a request to `provider` goes out in the client's shape. */
export function shapeOn(provider = "codearts") {
  const reader = readers.get(provider)
  if (!reader) return false
  try {
    return reader() === true
  } catch {
    return false
  }
}

// ── the wrap ───────────────────────────────────────────────────────────────

// An accessor on auth (CodeArts' `methods`: it answers what is on this machine,
// read once per listing) has to survive the wrap — a spread would call it here
// and freeze one answer for good.
function keepGetters(from, to) {
  for (const key of Object.keys(from)) {
    const d = Object.getOwnPropertyDescriptor(from, key)
    if (d?.get) Object.defineProperty(to, key, d)
  }
  return to
}

/**
 * Wrap the CodeArts plugin: its card gets the switch, and the gates inside
 * index.mjs read `shapeOn()`.
 *
 * `deps.wire` is how the switch is read at a request; left out, the reader is
 * cleared and every request keeps upstream's shape.
 */
export function extendCodeArts(plugin, deps = {}) {
  if (!plugin?.auth) return plugin
  const auth = keepGetters(plugin.auth, { ...plugin.auth })
  const out = { ...plugin, auth }
  auth.options = [...(auth.options ?? []), WIRE_OPTION]
  shapeReader("codearts", deps.wire)
  return out
}

/**
 * Wrap the OfficeAce plugin the same way: its card gets its own switch, and the
 * claim's signature reads `shapeOn("officeace")`.
 */
export function extendOfficeAce(plugin, deps = {}) {
  if (!plugin?.auth) return plugin
  const auth = keepGetters(plugin.auth, { ...plugin.auth })
  const out = { ...plugin, auth }
  auth.options = [...(auth.options ?? []), OA_WIRE_OPTION]
  shapeReader("officeace", deps.wire)
  return out
}
