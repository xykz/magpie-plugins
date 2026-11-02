#!/usr/bin/env node
// durindoor-to-magpie.mjs — turn DurinDoor's stored provider sign-ins into
// magpie's plugin-auth.json.
//
// Reads DurinDoor's SQLite database (providerConnections) and its
// <DATA_DIR>/master-key, decrypts the AES-256-GCM credential columns, and
// writes magpie's plugin-auth.json — the OpenCode auth.json shape magpie's
// plugin host reads and writes (magpie/internal/plugin/host.js, store.go).
//
// DurinDoor's shapes mirrored here, all verified against source:
//   src/lib/crypto/columnCrypto.js   AES-256-GCM, key = <DATA_DIR>/master-key
//                                    (exactly 32 bytes, 0600), iv 12B,
//                                    tag 16B, AAD = String(row.id),
//                                    blob {v:1, iv:base64, ct:base64(ct||tag)}
//   src/lib/db/repos/connectionsRepo.js  SENSITIVE_CONNECTION_FIELDS and the
//                                    row/JSON split (data holds the rest)
//   open-sse/providers/codebuddyCli.js   identity from the token's JWT:
//                                    X-User-Id = sub, X-Domain = iss host,
//                                    iss last segment "sso-*" → enterprise id
//   src/lib/oauth/flowCompletion.js  expiresAt written as an ISO string
//
// magpie's side:
//   internal/plugin/store.go:125     AuthPath() = settings.Dir()/plugin-auth.json
//   internal/plugin/host.js:930-990  writes under plugin-auth.json.lock
//                                    (wx 0600, stale 10s), temp+fsync+rename
//   internal/plugin/host.js:1039     freshKey: provider id, else provider#xxxxxx
//   packages/workbuddy/index.mjs     needs access/refresh/expires(unix ms)/
//                                    uid/domain[/enterpriseId]/accountId
//
// Zero dependencies: node:sqlite (Node >= 22.5) and node:crypto only.
//
//   node durindoor-to-magpie.mjs --db ~/.9router/db/data.sqlite --dry-run
//   node durindoor-to-magpie.mjs --db ~/.9router/db/data.sqlite --install
//
// Exit codes: 0 ok, 1 nothing to do / all rows skipped, 2 usage or read error.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";

// node:sqlite is built in from Node 22.5; loading it by name lets a missing
// one be a sentence rather than a failed import of the whole script.
const require = createRequire(import.meta.url);

const SENSITIVE_CONNECTION_FIELDS = ["accessToken", "refreshToken", "apiKey", "idToken", "firecrawlHeaders"];
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
const MASTER_KEY_BYTES = 32;
const AUTH_LOCK_STALE = 10 * 1000; // host.js: AUTH_LOCK_STALE

// PAIRS: DurinDoor provider id → the magpie plugin provider id that takes it.
// Only pairs whose request target really is the same vendor are listed: a
// magpie plugin must sign the request the way that vendor's own client does,
// and codebuddy-cn and WorkBuddy both POST copilot.tencent.com/v2/chat/
// completions (durindoor open-sse/providers/registry/codebuddy-cn.js:27,
// workbuddy index.mjs:71+152). Anything else needs its own mapping and is
// reported, never guessed.
const PAIRS = {
  "codebuddy-cn": { plugin: "workbuddy", site: "https://copilot.tencent.com", label: "CodeBuddy CN → WorkBuddy" },
};

// ---- arguments ---------------------------------------------------------------

const USAGE = `usage: node durindoor-to-magpie.mjs --db <data.sqlite> [options]

  --db <path>          DurinDoor's SQLite database (default $DATA_DIR/db/data.sqlite, else ~/.9router/db/data.sqlite)
  --key <path>         its master-key (default: the master-key beside the db's folder)
  --provider <id>      only rows of this provider (default codebuddy-cn; "all" reads every row)
  --as <plugin-id>     write them as this magpie plugin provider (overrides the table)
  --out <path>         where to write plugin-auth.json (default ./plugin-auth.import.json)
  --install            merge into magpie's own plugin-auth.json instead (lock, atomic, backup)
  --magpie-dir <path>  magpie's config folder (default $XDG_CONFIG_HOME/magpie, else ~/.config/magpie)
  --include-keys       also report API-key rows, as "magpie provider add" suggestions
  --dry-run            decrypt and report, write nothing
  --json               machine-readable report
  --selftest           check the decrypt path against DurinDoor's own algorithm
  -h, --help           this

The refresh token is spent once by whoever uses it first: after installing,
sign the connection out in DurinDoor (or delete it), or the next background
refresh there invalidates the account in magpie.`;

function parseArgs(argv) {
  const o = {
    db: null, key: null, provider: "codebuddy-cn", as: null, out: null,
    install: false, magpieDir: null, includeKeys: false, dryRun: false,
    json: false, selftest: false, help: false,
  };
  const need = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--db": o.db = need(++i, a); break;
      case "--key": o.key = need(++i, a); break;
      case "--provider": o.provider = need(++i, a); break;
      case "--as": o.as = need(++i, a); break;
      case "--out": o.out = need(++i, a); break;
      case "--magpie-dir": o.magpieDir = need(++i, a); break;
      case "--install": o.install = true; break;
      case "--keys": case "--include-keys": o.includeKeys = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--json": o.json = true; break;
      case "--selftest": o.selftest = true; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  return o;
}

// ---- DurinDoor's crypto ------------------------------------------------------

function readMasterKey(p) {
  let raw;
  try {
    raw = fs.readFileSync(p);
  } catch (e) {
    throw new Error(`can't read the master key at ${p}: ${e.message}\n` +
      `DurinDoor keeps it at <DATA_DIR>/master-key; without it the credential columns stay encrypted.`);
  }
  if (raw.length !== MASTER_KEY_BYTES) {
    throw new Error(`the master key at ${p} is ${raw.length} bytes, not ${MASTER_KEY_BYTES}: ` +
      `that is not DurinDoor's key (columnCrypto says the same)`);
  }
  return raw;
}

function isEncryptedBlob(v) {
  return !!v && typeof v === "object" && !Array.isArray(v) &&
    v.v === FORMAT_VERSION && typeof v.iv === "string" && typeof v.ct === "string";
}

// decryptField mirrors src/lib/crypto/columnCrypto.js decryptField exactly:
// AES-256-GCM, AAD = String(row.id), tag = the trailing 16 bytes of ct.
function decryptField(key, blob, aad) {
  if (blob.v !== FORMAT_VERSION) throw new Error(`unsupported blob version ${blob.v}`);
  const iv = Buffer.from(blob.iv, "base64");
  const packed = Buffer.from(blob.ct, "base64");
  if (iv.length !== IV_BYTES) throw new Error(`iv is ${iv.length} bytes, not ${IV_BYTES}`);
  if (packed.length < TAG_BYTES) throw new Error("ciphertext too short");
  const ct = packed.subarray(0, packed.length - TAG_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (aad != null) d.setAAD(Buffer.from(String(aad), "utf8"));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new Error("authentication failed (tampered, or the row id this blob was made for is not this row's)");
  }
}

// encryptField mirrors the same file's encryptField; used only by --selftest.
function encryptField(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (aad != null) c.setAAD(Buffer.from(String(aad), "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const packed = Buffer.concat([ct, c.getAuthTag()]);
  return { v: FORMAT_VERSION, iv: iv.toString("base64"), ct: packed.toString("base64") };
}

// ---- time and identity -------------------------------------------------------

// expiresAt is an ISO string in DurinDoor (flowCompletion.js:49-51) but a
// number in older rows and seconds when it came from expiresIn; magpie wants
// unix milliseconds in `expires` (host.js renewAt compares against Date.now()).
function toMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 0) return 0;
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "") return toMs(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function b64urlJson(part) {
  let s = String(part).replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
}

// jwtClaims reads a token's payload claims, null for anything that isn't a JWT.
function jwtClaims(token) {
  if (typeof token !== "string") return null;
  const t = token.startsWith("Bearer ") ? token.slice(7) : token;
  const parts = t.split(".");
  if (parts.length < 2) return null;
  try {
    const c = b64urlJson(parts[1]);
    return c && typeof c === "object" && !Array.isArray(c) ? c : null;
  } catch {
    return null;
  }
}

// identity mirrors open-sse/providers/codebuddyCli.js identityHeaders():
// X-User-Id = sub, X-Domain = iss hostname, and an iss whose last segment
// starts with "sso-" also gives the enterprise id (prefix stripped). The
// segment split is DurinDoor's own (`iss.split("/").pop()`), so a token
// yields the same three values on both sides.
function identity(accessToken) {
  const out = { uid: "", domain: "", enterpriseId: "" };
  const c = jwtClaims(accessToken);
  if (!c) return out;
  if (typeof c.sub === "string" && c.sub) out.uid = c.sub;
  if (typeof c.iss === "string" && c.iss) {
    try {
      out.domain = new URL(c.iss).hostname;
    } catch {
      // a non-URL issuer gives no domain, as the CLI's own fallback
    }
    const last = c.iss.split("/").pop() || "";
    if (last.startsWith("sso-")) out.enterpriseId = last.slice(4);
  }
  return out;
}

// ---- reading DurinDoor -------------------------------------------------------

function sqliteOpen(p) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("this Node has no node:sqlite (built in from Node 22.5); " +
      "run it with a newer Node, or export DurinDoor's database and import that JSON instead");
  }
  // read-only: never write to another app's database
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch (e) {
    throw new Error(`can't open ${p} read-only: ${e.message}`);
  }
}

function readRows(dbPath, onlyProvider, withKeys) {
  const db = sqliteOpen(dbPath);
  const cols = "id, provider, authType, name, email, priority, isActive, data";
  try {
    const out = [];
    const all = !onlyProvider || onlyProvider === "all";
    const query = (sql, ...params) => {
      try {
        return db.prepare(sql).all(...params);
      } catch (e) {
        if (/no such table/i.test(e.message)) {
          throw new Error(`${dbPath} has no providerConnections table: that isn't a DurinDoor database ` +
            `(it keeps one at <DATA_DIR>/db/data.sqlite)`);
        }
        throw e;
      }
    };
    if (all) out.push(...query(`SELECT ${cols} FROM providerConnections`));
    else out.push(...query(`SELECT ${cols} FROM providerConnections WHERE provider = ?`, onlyProvider));
    if (withKeys) {
      // API-key rows of every provider are reported, not merged; a second
      // query keeps --provider's meaning for the sign-ins.
      const seen = new Set(out.map((r) => r.id));
      for (const r of query(`SELECT ${cols} FROM providerConnections WHERE authType IN ('apikey','api_key')`)) {
        if (!seen.has(r.id)) out.push(r);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

// rowValues is rowToConn's work plus the decryption: data holds the rest, the
// credential fields are blobs {"v":1,"iv":…,"ct":…} until they are opened.
function rowValues(row, masterKey) {
  let data = {};
  if (typeof row.data === "string" && row.data.trim()) {
    try {
      data = JSON.parse(row.data);
    } catch (e) {
      throw new Error(`row ${row.id}: data is not JSON (${e.message})`);
    }
  } else if (row.data && typeof row.data === "object") {
    data = row.data;
  }
  const notes = [];
  for (const f of SENSITIVE_CONNECTION_FIELDS) {
    const v = data[f];
    if (!isEncryptedBlob(v)) continue;
    try {
      data[f] = decryptField(masterKey, v, row.id);
    } catch (e) {
      data[f] = undefined;
      notes.push(`${f}: ${e.message}`);
    }
  }
  return {
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    isActive: row.isActive === 1 || row.isActive === true,
    data,
    notes,
  };
}

// ---- building magpie's accounts ---------------------------------------------

// accountOf turns one DurinDoor row into a plugin-auth.json entry, or says
// why it can't. The shape is what host.js save() writes for a plugin's
// sign-in: {type:"oauth", refresh, access, expires, ...extra}, every extra
// field kept verbatim (host.js:2254-2258), which is how uid and domain reach
// the WorkBuddy plugin's sign().
function accountOf(v, pluginId) {
  const d = v.data;
  const access = typeof d.accessToken === "string" ? d.accessToken.trim() : "";
  const refresh = typeof d.refreshToken === "string" ? d.refreshToken.trim() : "";
  const why = v.notes.length ? `; ${v.notes.join("; ")}` : "";
  if (!access && !refresh) {
    return { skip: `no accessToken and no refreshToken in the row${why}` };
  }
  if (!access) {
    return { skip: `a refresh token with no access token — magpie renews only an account that has one${why}` };
  }
  const idn = identity(access);
  const uid = idn.uid || (typeof d.uid === "string" ? d.uid : "");
  const domain = idn.domain || (typeof d.domain === "string" ? d.domain : "");

  let expires = toMs(d.expiresAt);
  if (!expires && Number(d.expiresIn) > 0) expires = Date.now() + Number(d.expiresIn) * 1000;
  // a row that never stored an end (an "access_token" paste) still has one in
  // the token itself: exp is the same number magpie compares against
  if (!expires) expires = toMs(jwtClaims(access)?.exp);
  let refreshExpiresAt = toMs(d.refreshExpiresAt);
  if (!refreshExpiresAt && Number(d.refreshExpiresIn) > 0) refreshExpiresAt = Date.now() + Number(d.refreshExpiresIn) * 1000;

  const auth = {
    type: "oauth",
    access,
    refresh,
    // a sign-in with neither an end nor a refresh token can't be renewed; 0
    // is what host.js renewAt reads as "never" (host.js:2330-2365), so it is
    // left 0 rather than invented.
    expires,
    uid,
    ...(domain ? { domain } : {}),
    ...(idn.enterpriseId ? { enterpriseId: idn.enterpriseId } : {}),
    ...(refreshExpiresAt ? { refreshExpiresAt } : {}),
    ...(typeof d.tokenType === "string" && d.tokenType ? { tokenType: d.tokenType } : {}),
    accountId: displayName(v, idn.uid),
  };

  const notes = [...v.notes];
  if (!refresh) notes.push("no refresh token: the account works until this access token ends and is never renewed");
  if (!uid) notes.push("no uid: the token isn't a JWT and the row stores no account id, so X-User-Id would go empty");
  if (!domain) notes.push("no domain: the plugin falls back to the site's own host for X-Domain");
  if (!expires) notes.push("no expiry: the account is never renewed by time, only on a 401");
  if (v.isActive === false) notes.push("the connection is switched off in DurinDoor");
  return { auth, pluginId, notes };
}

function displayName(v, sub) {
  const d = v.data;
  for (const c of [d.displayName, d.email, v.name, v.email]) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 120);
  }
  if (sub) return `DurinDoor · ${sub.length > 12 ? sub.slice(0, 6) + "…" + sub.slice(-4) : sub}`;
  return "DurinDoor import";
}

// freshKey mirrors host.js freshKey(): the provider's own id while it is free,
// else provider + "#" + 6 random base36 characters.
function freshKey(all, provider) {
  if (!(provider in all)) return provider;
  for (;;) {
    const k = provider + "#" + Math.random().toString(36).slice(2, 8);
    if (!(k in all)) return k;
  }
}

// ---- magpie's file -----------------------------------------------------------

function magpieConfigDir(explicit) {
  if (explicit) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "magpie");
  return path.join(os.homedir(), ".config", "magpie");
}

function readExistingAuth(authPath) {
  let raw;
  try {
    raw = fs.readFileSync(authPath);
  } catch (e) {
    if (e.code === "ENOENT") return { all: {}, existed: false };
    throw new Error(`can't read ${authPath}: ${e.message}`);
  }
  if (raw.length === 0 || raw.every((b) => b === 0)) {
    // host.js reads an all-zero file as "unknown", not empty, and refuses to
    // write over it; so does this.
    throw new Error(`${authPath} is empty or zeroed: magpie would read that as unknown rather than as none. ` +
      `Restore it (${authPath}.bak) before importing.`);
  }
  let all;
  try {
    all = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    throw new Error(`${authPath} doesn't parse (${e.message}). Not writing over it: ` +
      `its sign-ins would be lost. Fix or restore it first.`);
  }
  if (!all || typeof all !== "object" || Array.isArray(all)) {
    throw new Error(`${authPath} isn't a JSON object of accounts; not writing over it`);
  }
  return { all, existed: true };
}

// lockAuth mirrors host.js lockAuth(): the same file, wx 0600, a lock older
// than AUTH_LOCK_STALE is a dead host's and is taken, and the wait is bounded.
function lockAuth(authPath) {
  const lock = authPath + ".lock";
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  for (const start = Date.now(); ; ) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      return () => { try { fs.unlinkSync(lock); } catch {} };
    } catch (e) {
      if (e?.code !== "EEXIST" && e?.code !== "EPERM" && e?.code !== "EACCES") throw e;
    }
    let old = false;
    try { old = Date.now() - fs.statSync(lock).mtimeMs > AUTH_LOCK_STALE; } catch {}
    if (old || Date.now() - start > 2 * AUTH_LOCK_STALE) {
      try { fs.unlinkSync(lock); } catch {}
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

// writeDurable mirrors host.js writeDurable: a temp file in the same folder,
// flushed, then renamed over the target — a reader never sees half a file.
function writeDurable(p, buf) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch {}
}

// ---- selftest ----------------------------------------------------------------

function selftest() {
  const key = crypto.randomBytes(MASTER_KEY_BYTES);
  const cases = [
    ["plain token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.x", "row-1"],
    ["unicode", "令牌·トークン·🎫", "row-2"],
    ["empty", "", "row-3"],
    ["long", "a".repeat(5000), "row-4"],
  ];
  for (const [name, plain, aad] of cases) {
    const blob = encryptField(key, plain, aad);
    const back = decryptField(key, blob, aad);
    if (back !== plain) throw new Error(`selftest: ${name} didn't round-trip`);
    let threw = false;
    try { decryptField(key, blob, aad + "x"); } catch { threw = true; }
    if (!threw) throw new Error(`selftest: ${name} decrypted with the wrong AAD`);
  }
  const jwt = "h." + Buffer.from(JSON.stringify({ sub: "u-42", iss: "https://www.codebuddy.cn/sso-acme" })).toString("base64url") + ".s";
  const idn = identity(jwt);
  if (idn.uid !== "u-42" || idn.domain !== "www.codebuddy.cn" || idn.enterpriseId !== "acme") {
    throw new Error(`selftest: identity is ${JSON.stringify(idn)}`);
  }
  const personal = identity("h." + Buffer.from(JSON.stringify({ sub: "u-7", iss: "https://www.codebuddy.cn" })).toString("base64url") + ".s");
  if (personal.enterpriseId !== "" || personal.domain !== "www.codebuddy.cn") {
    throw new Error(`selftest: a personal issuer gave ${JSON.stringify(personal)}`);
  }
  if (identity("not-a-jwt").uid !== "") throw new Error("selftest: a non-JWT should read as no identity");
  if (toMs("2026-11-02T00:00:00.000Z") !== Date.parse("2026-11-02T00:00:00.000Z")) throw new Error("selftest: ISO time");
  if (toMs(1762000000) !== 1762000000000) throw new Error("selftest: seconds time");
  if (toMs(1762000000000) !== 1762000000000) throw new Error("selftest: ms time");
  console.log("selftest ok: decrypt round-trips (wrong AAD refused), identity and times read right");
}

// ---- main --------------------------------------------------------------------

// say writes a human line to stdout, or to stderr when --json has stdout
// reserved for the report alone (so `... --json | jq` stays valid).
let humanToStderr = false;
function say(s = "") {
  (humanToStderr ? process.stderr : process.stdout).write(s + "\n");
}

// a reader that stops early (`| head`) is not an error: exit quietly
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

// durindoorDataDir mirrors src/lib/dataDir.js: DATA_DIR when set, else
// %APPDATA%\9router on Windows and ~/.9router elsewhere.
function durindoorDataDir() {
  const configured = process.env.DATA_DIR;
  if (configured && !(process.platform === "win32" && configured.startsWith("/"))) {
    return path.resolve(configured);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return 0; }
  if (o.selftest) { selftest(); return 0; }
  humanToStderr = o.json;

  const dbPath = o.db ? path.resolve(o.db) : path.join(durindoorDataDir(), "db", "data.sqlite");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`no database at ${dbPath}\nDurinDoor keeps it at <DATA_DIR>/db/data.sqlite. Pass --db.`);
  }
  const keyPath = o.key ? path.resolve(o.key) : path.join(path.dirname(path.dirname(dbPath)), "master-key");
  const masterKey = readMasterKey(keyPath);

  const rows = readRows(dbPath, o.provider, o.includeKeys);
  if (!rows.length) {
    throw new Error(`no rows of provider "${o.provider}" in ${dbPath}  (list them all with --provider all)`);
  }

  const authPath = path.join(magpieConfigDir(o.magpieDir), "plugin-auth.json");
  const { all: existing, existed } = o.install
    ? readExistingAuth(authPath)
    : { all: {}, existed: false };
  const out = { ...existing };

  const pairs = [];
  const skipped = [];
  const keyRows = [];
  const usedNames = new Set();

  for (const row of rows) {
    let v;
    try {
      v = rowValues(row, masterKey);
    } catch (e) {
      skipped.push({ provider: row.provider, id: row.id, reason: e.message });
      continue;
    }
    // DurinDoor's three authType values: "oauth", "apikey", "access_token"
    // (src/app/api/oauth/[provider]/[action]/route.js:381). The first two are
    // sign-ins; a key belongs to a custom provider, not to an account.
    if (row.authType !== "oauth" && row.authType !== "access_token") {
      if (row.authType === "apikey" || row.authType === "api_key") {
        keyRows.push({ provider: row.provider, name: v.name || v.data?.name || "", key: v.data?.apiKey || "", id: row.id });
      } else {
        skipped.push({ provider: row.provider, id: row.id, reason: `authType "${row.authType}" isn't a plugin sign-in` });
      }
      continue;
    }
    const pluginId = o.as || PAIRS[row.provider]?.plugin || null;
    if (!pluginId) {
      skipped.push({
        provider: row.provider, id: row.id,
        reason: "no magpie plugin is known to take this provider — run with --as <plugin-id> once you know which one does",
      });
      continue;
    }
    const built = accountOf(v, pluginId);
    if (built.skip) {
      skipped.push({ provider: row.provider, id: row.id, reason: built.skip });
      continue;
    }
    // an account already here is the same account when the secret matches, or,
    // with no secret to compare, the uid (host.js settle() folds by the same
    // two: whoOf/uid and secret)
    const same = Object.keys(out).find((k) => {
      const a = out[k];
      if (!a || a.type !== "oauth") return false;
      if (built.auth.refresh && a.refresh === built.auth.refresh) return true;
      if (!built.auth.refresh && a.access && a.access === built.auth.access) return true;
      return !!built.auth.uid && a.uid === built.auth.uid;
    });
    const key = same ?? freshKey(out, pluginId);
    // an account id is how magpie names an account and folds a duplicate
    // (host.js whoOf/settle), so two rows that arrived with the same display
    // name get the uid tail to tell them apart
    if (!same && usedNames.has(built.auth.accountId)) {
      // the key's own suffix is short and already unique: "Account 1 · fb8ume"
      const tail = key.split("#")[1] || (built.auth.uid ? built.auth.uid.slice(-6) : String(pairs.length + 1));
      built.auth.accountId = `${built.auth.accountId} · ${tail}`;
    }
    usedNames.add(built.auth.accountId);
    out[key] = built.auth;
    pairs.push({
      provider: row.provider, plugin: pluginId, key,
      status: same ? "exists" : "added",
      accountId: built.auth.accountId,
      uid: built.auth.uid,
      domain: built.auth.domain ?? "",
      expires: built.auth.expires,
      notes: built.notes,
    });
  }

  // ---- report ----
  if (o.json) {
    console.log(JSON.stringify({ db: dbPath, key: keyPath, target: o.install ? authPath : (o.out ?? "plugin-auth.import.json"), accounts: pairs, skipped, keys: keyRows }, null, 2));
  } else {
    const line = "─".repeat(72);
    say(`database  ${dbPath}`);
    say(`master-key ${keyPath}`);
    say(`target    ${o.dryRun ? "(dry run, nothing written)" : o.install ? authPath : (o.out ?? "plugin-auth.import.json")}`);
    say(line);
    if (pairs.length) {
      say(`${pairs.length} account${pairs.length === 1 ? "" : "s"}:`);
      for (const p of pairs) {
        const exp = p.expires ? new Date(p.expires).toISOString().replace(".000Z", "Z") : "—";
        say(`  ✓ ${p.plugin.padEnd(12)} key=${p.key}  (${p.status})`);
        say(`      ${p.accountId}`);
        say(`      uid=${p.uid || "(none)"}  domain=${p.domain || "(site host)"}  expires=${exp}`);
        for (const n of p.notes) say(`      · ${n}`);
      }
    }
    if (skipped.length) {
      say(`\n${skipped.length} row${skipped.length === 1 ? "" : "s"} left alone:`);
      for (const s of skipped) say(`  – ${s.provider} (${s.id}): ${s.reason}`);
    }
    if (o.includeKeys && keyRows.length) {
      say(`\n${keyRows.length} API-key row${keyRows.length === 1 ? "" : "s"} (not merged: magpie takes a key as a custom provider's):`);
      for (const k of keyRows) {
        const kk = k.key ? `${k.key.slice(0, 6)}…${k.key.slice(-4)}` : "(unreadable)";
        say(`  – ${k.provider}  ${k.name || ""}  ${kk}`);
      }
    }
    say(line);
  }

  if (o.dryRun) return pairs.length ? 0 : 1;

  // ---- write ----
  if (o.install) {
    if (!pairs.length) return 1;
    const unlock = lockAuth(authPath);
    try {
      // read again under the lock: a host may have written since the report
      const { all: now } = readExistingAuth(authPath);
      let changed = 0;
      for (const p of pairs) {
        if (p.status === "exists" && now[p.key]) continue;
        now[p.key] = out[p.key];
        changed++;
      }
      if (!changed) {
        // nothing new: leave the file, and its mtime — the one host.js caches
        // a parse on — exactly as they were
        say(`unchanged ${authPath} (${Object.keys(now).length} account${Object.keys(now).length === 1 ? "" : "s"})`);
        return 0;
      }
      if (existed) {
        const bak = `${authPath}.pre-import-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(authPath, bak);
        say(`backup    ${bak}`);
      }
      writeDurable(authPath, Buffer.from(JSON.stringify(now, null, 2) + "\n"));
      say(`wrote     ${authPath} (${Object.keys(now).length} account${Object.keys(now).length === 1 ? "" : "s"})`);
    } finally {
      unlock();
    }
  } else {
    const p = path.resolve(o.out ?? "plugin-auth.import.json");
    writeDurable(p, Buffer.from(JSON.stringify(out, null, 2) + "\n"));
    say(`wrote     ${p}`);
  }

  if (pairs.length) {
    const plugins = [...new Set(pairs.map((p) => p.plugin))];
    const add = plugins.map((p) => `magpie plugin add ${p}`);
    const show = plugins.map((p) => `magpie accounts ${p} --json`);
    const width = Math.max(...[...add, ...show].map((s) => s.length)) + 3;
    say("\nnext:");
    for (const s of add) say("  " + s.padEnd(width) + "# once, if it isn't installed already");
    for (const s of show) say("  " + s.padEnd(width) + "# the account reads back");
    say(`
Then remove the connection in DurinDoor. A refresh token is spent by whichever
side uses it first: DurinDoor's next background refresh would take it, and
magpie's own refresh would then fail with invalid_grant.`);
  }
  return pairs.length ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`error: ${e?.message ?? e}`);
  if (process.env.DURINDOOR_TO_MAGPIE_DEBUG) console.error(e);
  process.exitCode = 2;
}
