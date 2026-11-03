// renew.mjs — Loomy's password sign-in, where the password is kept, and the
// two renewal paths. Split out of index.mjs on purpose: this is the part that
// upstream's plugin does not have, so keeping it in its own file means a merge
// of upstream index.mjs touches four lines there and never conflicts here.
//
// Loomy hands out no refresh token (constants.py:45-46, config.go:37-38, and
// this plugin's own loader note all say so). A session lives 14 days and the
// only thing that extends it is signing in again — so the password IS the
// renewal credential, and only password accounts can renew. SMS sign-ins and
// pasted sessions carry no password and physically cannot; they behave exactly
// as before.
//
// The password is kept on the sign-in record in `refresh`, as JSON. That is
// the field magpie uses as an oauth account's secret (host.js secretOf), and
// it is where the repo already keeps multi-part credentials (zcode's
// `refresh: JSON.stringify(state)`, mimo's `refresh: JSON.stringify(creds)`).
// It lands in plugin-auth.json — mode 600, plaintext, not an encrypted vault.

import { createPublicKey, publicEncrypt, constants } from "node:crypto"

// session length the client asks for (expire=1209600 in the login body)
const SESSION_MS = 14 * 86400e3
// renew this far before the end. Loomy's session is 14 days, not the hours an
// access token lives, so the repo's usual 5-10 minutes would leave no room to
// retry; 3 days matches loomy2api's session_renew_before_days default
const RENEW_LEAD = 3 * 86400e3

/**
 * The password sealed to the public key getPuKey just handed out: 1024-bit
 * RSA, PKCS#1 v1.5 (agent2api login.rs, loomy2api crypto.py, the panel's
 * account.PublicKey). node:crypto does this in-process — no dependency.
 *
 * Two things the real upstream does that a strict decoder rejects: the base64
 * `pukey` arrives without padding, and it may be either a full SPKI
 * SubjectPublicKeyInfo or a bare PKCS#1 RSAPublicKey. Both are tried.
 */
export function sealPassword(pukey, password) {
  const b64 = String(pukey ?? "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
  // Buffer.from tolerates missing padding; adding it costs nothing and keeps
  // this working if the DER is ever handed to something stricter
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
  const der = Buffer.from(padded, "base64")
  if (!der.length) throw new Error("Loomy 返回的公钥为空")
  let key
  for (const type of ["spki", "pkcs1"]) {
    try {
      key = createPublicKey({ key: der, format: "der", type })
      break
    } catch {}
  }
  if (!key) throw new Error("Loomy 返回的公钥无法解析（既不是 SPKI 也不是 PKCS#1）")
  const sealed = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(String(password), "utf8"))
  return sealed.toString("base64")
}

const said = (res, v) => {
  const h = new Headers(res.headers)
  h.set("X-Magpie-Sign-In", v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}

/**
 * Everything renewal needs from the plugin, wired in by index.mjs in one call.
 * The deps are passed rather than imported so this file never reaches back into
 * index.mjs (no import cycle, and upstream's helpers stay the single copy).
 */
export function loomyRenewal({ client, signedPost, makeBase, codeOf, messageOf, normalizePhone, OK, AUTH_CODES, ID }) {
  // one sign-in per account at a time: two concurrent renewals would have the
  // second invalidate the first's session
  const renewing = new Map()
  // what each account was last renewed to, so a hook that fires twice in a row
  // does not sign in twice for nothing
  const renewed = new Map()

  const maskOf = (loginid) => `${String(loginid).slice(0, 3)}****${String(loginid).slice(-4)}`

  /** The credentials kept on a sign-in record, or null when it has none. */
  function credentialsOf(auth) {
    if (auth?.type !== "oauth") return null
    const raw = String(auth?.refresh ?? "").trim()
    // "" is what SMS and pasted sessions carry — nothing to renew with
    if (!raw.startsWith("{")) return null
    let got
    try {
      got = JSON.parse(raw)
    } catch {
      return null
    }
    const loginid = normalizePhone(got?.loginid ?? got?.phone)
    const password = String(got?.password ?? "")
    if (!loginid || !password) return null
    return { loginid, password }
  }

  /**
   * The password sign-in: getPuKey hands out a public key and a nonce, byPwd
   * answers the password sealed to it. `rcode` is the server's nonce, not a
   * captcha, so the whole chain runs unattended — that is what makes renewal
   * possible at all.
   */
  async function passwordLogin(loginid, password) {
    const key = await signedPost("/login/account/getPuKey", { base: makeBase() })
    if (codeOf(key) !== OK) throw new Error(`获取登录公钥失败：${messageOf(key) || `code=${codeOf(key)}`}`)
    const pukey = key?.data?.pukey
    const rcode = key?.data?.rcode
    if (!pukey) throw new Error("Loomy 没有返回登录公钥")
    const answer = await signedPost("/login/account/byPwd", {
      base: makeBase(),
      param: { loginid, password: sealPassword(pukey, password), rcode, type: 1, expire: 1209600 },
    })
    const code = codeOf(answer)
    if (code !== OK) {
      // HTTP 200 with a business code is the vendor refusing on purpose (wrong
      // password, frozen account) — the one case that may end the sign-in.
      // `refused` carries that distinction up; transport errors never set it.
      throw Object.assign(new Error(messageOf(answer) || `密码登录被拒绝（code=${code}）`), { refused: true, code })
    }
    const session = String(answer?.data?.session ?? "").trim()
    if (!session) throw new Error("密码登录成功但 Loomy 没有返回 session")
    const userid = String(answer?.data?.userid ?? answer?.data?.userId ?? "").trim()
    return { session, userid }
  }

  /** Sign in again for this account, at most once at a time. */
  async function renewFor(auth) {
    const cred = credentialsOf(auth)
    if (!cred) return null
    const key = String(auth?.accountId || auth?.uid || cred.loginid)
    // a renewal already made in this process counts, so a hook firing with a
    // stale copy of the record does not buy a second session. Not when the
    // caller is holding that very session, though: it was just refused, so
    // handing it back would repeat the same 401.
    const had = renewed.get(key)
    if (had && had.session !== String(auth?.access ?? "") && had.expires - RENEW_LEAD > Date.now()) return had
    const running = renewing.get(key)
    if (running) return running
    const p = (async () => {
      const got = await passwordLogin(cred.loginid, cred.password)
      const expires = Date.now() + SESSION_MS
      renewed.set(key, { ...got, expires })
      // the host saves what auth.refresh returns, but this path is the loader
      // and usage/checkin, where nothing saves it for us
      try {
        await client?.auth?.set?.({ path: { id: ID }, body: { ...auth, access: got.session, expires } })
      } catch {}
      return { ...got, expires }
    })()
    renewing.set(key, p)
    try {
      return await p
    } finally {
      renewing.delete(key)
    }
  }

  /** magpie's renewal: called once per account, RENEW_LEAD before the end. */
  async function refresh(auth) {
    // no password (SMS / pasted session) — there is nothing to renew, and
    // undefined is the right answer: the host leaves the record alone
    if (!credentialsOf(auth)) return undefined
    try {
      const got = await renewFor(auth)
      if (!got) return undefined
      // only what changed: the host merges this onto the sign-in record, so
      // `refresh` (the credentials) is deliberately absent
      return { access: got.session, expires: got.expires, ...(got.userid ? { uid: got.userid } : {}) }
    } catch (e) {
      // host.js records its RENEW_RETRY cooldown only when this throws;
      // returning undefined would have it retry the same doomed call on every
      // hook until the session expired on its own. A vendor refusal marks the
      // sign-in lapsed; a transport failure leaves the account as it was.
      if (e?.refused) throw Object.assign(new Error(String(e.message)), { signIn: "expired" })
      throw e
    }
  }

  /**
   * A loader whose fetch survives a dead session. OpenCode never calls
   * auth.refresh (README.md:286), so on that host this is the only thing that
   * can revive an account: a 401/403 signs in again and the request is sent
   * once more. index.mjs's own 401 branches are left exactly as upstream wrote
   * them — they only run when this could not recover.
   */
  function wrapLoader(inner) {
    return async function loader(getAuth) {
      const made = await inner(getAuth)
      if (!made || typeof made.fetch !== "function") return made
      // the loader's fetch closes over the getAuth it was built with, so a
      // retry has to be built again against the renewed session
      const bound = async (auth) => {
        const again = await inner(async () => auth)
        return typeof again?.fetch === "function" ? again.fetch : made.fetch
      }
      return {
        ...made,
        async fetch(input, init) {
          const first = await made.fetch(input, init)
          if (first.status !== 401 && first.status !== 403) return first
          const auth = await getAuth()
          // nothing to renew with: the session really is gone, and saying so
          // is what lets magpie stop asking a dead account
          if (!credentialsOf(auth)) return said(first, "expired")
          let got
          try {
            got = await renewFor(auth)
          } catch (e) {
            // the vendor refused the password: lapsed. A transport failure is
            // not a verdict on the sign-in, so it stays as it was.
            return said(first, e?.refused ? "expired" : "kept")
          }
          if (!got) return said(first, "expired")
          let again
          try {
            again = await (await bound({ ...auth, access: got.session, expires: got.expires }))(input, init)
          } catch {
            return said(first, "renewed")
          }
          const lapsed = again.status === 401 || again.status === 403
          return said(again, lapsed ? "expired" : "renewed")
        },
      }
    }
  }

  /**
   * usage and checkin capture the session once at their top, so a dead one has
   * to be renewed outside them and the hook run again. usage reports the lapse
   * as a return value, checkin throws it; both are handled.
   */
  function wrapHook(inner) {
    const again = async (getAuth, got) => inner(async () => ({ ...(await getAuth()), access: got.session, expires: got.expires }))
    return async function (getAuth) {
      let out
      try {
        out = await inner(getAuth)
      } catch (e) {
        if (e?.signIn !== "expired") throw e
        const got = await renewFor(await getAuth()).catch(() => null)
        if (!got) throw e
        return await again(getAuth, got)
      }
      if (out?.signIn !== "expired") return out
      const got = await renewFor(await getAuth()).catch(() => null)
      if (!got) return out
      return await again(getAuth, got)
    }
  }

  const method = {
    type: "oauth",
    label: "账号密码登录（Password sign-in）",
    prompts: [
      {
        type: "text",
        key: "loginid",
        message: "Loomy 账号手机号（11 位）",
        validate: (v) => (normalizePhone(v) ? undefined : "请填写 11 位中国大陆手机号"),
      },
      {
        type: "password",
        key: "password",
        message: "账号密码（明文存于 plugin-auth.json，仅用于 14 天自动续登）",
        validate: (v) => (String(v ?? "").trim() ? undefined : "密码不能为空"),
      },
    ],
    authorize: (inputs) => {
      const loginid = normalizePhone(inputs?.loginid)
      const password = String(inputs?.password ?? "")
      if (!loginid || !password) return { type: "failed", error: "手机号与密码都必填" }
      return {
        // nothing to open: the sign-in is two server calls behind the scenes
        url: "",
        instructions: "正在用账号密码登录 Loomy…",
        method: "auto",
        callback: async () => {
          try {
            const got = await passwordLogin(loginid, password)
            return {
              type: "success",
              // magpie files oauth records under `refresh`; that is where the
              // credentials live so auth.refresh can sign in again later
              refresh: JSON.stringify({ loginid, password }),
              access: got.session,
              // a real end, unlike the pasted session's 0: this account can be
              // renewed ahead of it
              expires: Date.now() + SESSION_MS,
              accountId: maskOf(loginid),
              ...(got.userid ? { uid: got.userid } : {}),
              source: "password",
            }
          } catch (e) {
            return { type: "failed", error: `密码登录失败：${e?.message ?? e}` }
          }
        },
      }
    },
  }

  /**
   * One call from index.mjs: adds the password method, the host-side renewal
   * and the two fallbacks, and hands the hooks back for the plugin to return.
   */
  function extend(hooks) {
    if (!hooks?.auth) return hooks
    const methods = Array.isArray(hooks.auth.methods) ? hooks.auth.methods : (hooks.auth.methods = [])
    // first in the picker: an account signed in this way needs no code typed
    // now and no re-sign-in in 14 days
    methods.unshift(method)
    hooks.auth.refreshLead = RENEW_LEAD
    hooks.auth.refresh = refresh
    const inner = hooks.auth.loader
    if (typeof inner === "function") hooks.auth.loader = wrapLoader(inner)
    for (const key of ["usage", "checkin"]) {
      const fn = hooks.auth[key]
      if (typeof fn === "function") hooks.auth[key] = wrapHook(fn)
    }
    return hooks
  }

  return { extend, refresh, passwordLogin, credentialsOf, method, RENEW_LEAD, SESSION_MS }
}
