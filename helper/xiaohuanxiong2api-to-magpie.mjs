#!/usr/bin/env node
// xiaohuanxiong2api-to-magpie.mjs — turn xiaohuanxiong2api's accounts.json
// into magpie's plugin-auth.json, for the `raccoon` community plugin.
//
// xiaohuanxiong2api keeps a pool of SenseTime Raccoon (商汤小浣熊) accounts and
// serves OpenAI-compatible chat from them; magpie's raccoon plugin
// (magpie-community-plugins/packages/raccoon) signs in to the same vendor. The
// two hold the same credentials in different shapes, so an account moves across
// as it is — no re-login, no vendor round trip.
//
// xiaohuanxiong2api's side, verified against source:
//   src/internal/pool/pool.go:33-47    Account{id,name,user_id,access_token,
//                                      refresh_token,expires_at,enabled,
//                                      priority,last_refresh_at,
//                                      cooldown_until,last_error} + unknown
//                                      fields kept verbatim (extra)
//   src/internal/pool/pool.go:180-194  persist() writes {"accounts":[...]}
//   src/internal/pool/pool.go:61-63    a missing "enabled" reads as true
//   src/internal/upstream/jwt.go:13-38 JWTExpiry: exp (seconds) * 1000
//   src/internal/upstream/jwt.go:44    JWTUserID: user_id/userId/uid/userID
//   src/internal/upstream/refresh.go   POST {auth_base}/refresh
//                                      {"refresh_token": …} → data.access_token,
//                                      data.refresh_token   (rotating)
//   src/internal/server/admin.go:169   id = "user-"+uid, else "acct-"+hex
//
// magpie's side, verified against source:
//   internal/plugin/store.go:125       AuthPath() = settings.Dir()/plugin-auth.json
//   internal/plugin/host.js:931-935    written as JSON, 2-space, behind
//                                      plugin-auth.json.bak
//   internal/plugin/host.js:1039-1046  freshKey: the provider id, else id#xxxxxx
//   internal/plugin/host.js:1017-1021  accountsOf: the id's own key first
//   internal/plugin/host.js:1052-1054  whoOf: accountId, else metadata.email, email
//   internal/plugin/host.js:1061-1069  secretOf: oauth → refresh, else access;
//                                      uidOf: uid
//   internal/plugin/host.js:1088-1114  settle: two keys with the same accountId
//                                      (and no differing uid), the same rename,
//                                      or the same secret are one account
//   internal/plugin/host.js:844-935    writeDurable (temp+fsync+rename) and
//                                      lockAuth (wx 0600, stale 10s)
//   internal/provider/logins.go:73-135 logins.json is where on/off lives; a
//                                      sign-in not listed there is added, on,
//                                      by pluginLogins (plugin_accounts.go:266-274)
//   packages/raccoon/index.mjs         the record it reads and writes:
//                                      {type:"oauth", access, refresh, expires
//                                      (unix ms), uid, name?, accountId,
//                                      phone?, cardName?, source?}
//                                      source:"desktop" means read-only — never
//                                      set here, or a refreshable account would
//                                      stop renewing.
//
// What does NOT carry over, because xiaohuanxiong2api has it and magpie does not:
//   · priority / accounts.strategy (magpie orders accounts its own way — see
//     --sort below for how the plain `raccoon` key is chosen)
//   · cooldown_until, last_refresh_at, last_error (runtime state, not identity)
//   · office_identity / office_org_name / office_org_role (extra fields written
//     by xiaohuanxiong2api's sign-in; the raccoon plugin never reads them)
//   · phone / cardName (read from /api/web/auth/v1/user_info at sign-in; this
//     script stays offline, so the card shows the account's name instead)
//
// One thing to know before running it: a Raccoon refresh token is spent by
// whoever redeems it first. Once magpie refreshes one of these accounts, the
// same entry in accounts.json is dead, and xiaohuanxiong2api's next refresh of
// it fails. Run with --install, then take those accounts out of accounts.json.
//
//   node xiaohuanxiong2api-to-magpie.mjs --accounts ./data/accounts.json --dry-run
//   node xiaohuanxiong2api-to-magpie.mjs --accounts ./data/accounts.json --install
//
// Zero dependencies; Node >= 18 (no node:sqlite, no crypto beyond base64url).
//
// Exit codes: 0 ok, 1 nothing to do / every row skipped, 2 usage or read error.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PLUGIN = "raccoon";
const AUTH_LOCK_STALE = 10 * 1000; // host.js: AUTH_LOCK_STALE
const PROVIDER_NAME = "商汤小浣熊";
// The vendor's own JWT carries the account's id under these, in this order
// (raccoon/index.mjs:91-102): a hex id in sid (or iss) first, then the plain
// sub/id/user_id. Mirrored exactly, because magpie's sameAccount compares a
// seat's uid with the one a desktop read carries.
const HEX_ID_CLAIMS = ["sid", "iss"];
const PLAIN_ID_CLAIMS = ["sub", "id", "user_id"];

const USAGE = `usage: node xiaohuanxiong2api-to-magpie.mjs --accounts <accounts.json> [options]

  --accounts <path>    xiaohuanxiong2api's pool file (default ./data/accounts.json,
                       or $XHX_ACCOUNTS_FILE when that names one)
  --out <path>         where to write plugin-auth.json (default ./plugin-auth.import.json)
  --install            merge into magpie's own plugin-auth.json instead
                       (lock, backup, atomic write)
  --magpie-dir <path>  magpie's config folder (default $XDG_CONFIG_HOME/magpie,
                       else ~/.config/magpie)
  --plugin <id>        the magpie plugin provider id to write them as
                       (default ${DEFAULT_PLUGIN})
  --sort <order>       which account gets the plain provider key, so magpie
                       lists and tries it first: priority (lowest number first,
                       as xiaohuanxiong2api's priority strategy picks), or
                       file (the order in accounts.json). Default priority.
  --include-disabled   carry accounts with "enabled": false (they are skipped
                       otherwise, since magpie keeps on/off in logins.json and
                       would list them as in use)
  --dry-run            read and report, write nothing
  --json               machine-readable report on stdout
  --selftest           check the JWT and time paths against known values
  -h, --help           this
`;

// ---- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    accounts: null, out: null, install: false, magpieDir: null,
    plugin: DEFAULT_PLUGIN, sort: "priority", includeDisabled: false,
    dryRun: false, json: false, selftest: false, help: false,
  };
  const need = (i, name) => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--accounts": case "--file": o.accounts = need(++i, a); break;
      case "--out": o.out = need(++i, a); break;
      case "--install": o.install = true; break;
      case "--magpie-dir": o.magpieDir = need(++i, a); break;
      case "--plugin": case "--as": o.plugin = need(++i, a); break;
      case "--sort": o.sort = need(++i, a); break;
      case "--include-disabled": o.includeDisabled = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--json": o.json = true; break;
      case "--selftest": o.selftest = true; break;
      case "-h": case "--help": o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!["priority", "file"].includes(o.sort)) throw new Error(`--sort takes priority or file, not "${o.sort}"`);
  return o;
}

// ---- the vendor's JWT --------------------------------------------------------

function stripBearer(value) {
  return String(value ?? "").trim().replace(/^Bearer\s+/i, "").trim();
}

function decodeJwtClaims(token) {
  const parts = stripBearer(token).split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const obj = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

// jwtExpiryMs is raccoon/index.mjs:75-79: exp in seconds, in ms; 0 when the
// token carries none, which magpie reads as "never expires".
function jwtExpiryMs(token) {
  const exp = Number(decodeJwtClaims(token)?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
}

function hexIdToDecimal(val) {
  const raw = String(val ?? "").trim().replace(/^0x/i, "");
  if (!raw || !/^[0-9a-fA-F]+$/.test(raw)) return "";
  try {
    return BigInt("0x" + raw).toString(10);
  } catch {
    return "";
  }
}

function extractUserId(claims) {
  if (!claims) return "";
  for (const k of HEX_ID_CLAIMS) {
    const dec = hexIdToDecimal(claims[k]);
    if (dec) return dec;
  }
  for (const k of PLAIN_ID_CLAIMS) {
    const s = String(claims[k] ?? "").trim();
    if (s) return s;
  }
  return "";
}

function extractDisplayName(claims) {
  return String(claims?.name ?? "").trim();
}

// ---- xiaohuanxiong2api's file -------------------------------------------------

function defaultAccountsFile() {
  const env = process.env.XHX_ACCOUNTS_FILE;
  if (env) return path.resolve(env);
  return path.resolve("data", "accounts.json");
}

function readAccountsFile(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`can't read ${p}: ${e.message}\n` +
      `xiaohuanxiong2api keeps its pool at accounts.file (default ./data/accounts.json). Pass --accounts.`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${p} doesn't parse (${e.message})`);
  }
  // pool.persist writes {"accounts": [...]}; a hand-made file is sometimes the
  // bare array, which is taken as it is.
  const rows = Array.isArray(json) ? json : json?.accounts;
  if (!Array.isArray(rows)) {
    throw new Error(`${p} has no "accounts" array — that is not a pool file xiaohuanxiong2api wrote`);
  }
  return rows;
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

// unixMs reads a time that should be unix milliseconds. xiaohuanxiong2api
// writes ms (pool.go:255,331,442); a seconds value is taken as seconds, since
// a bare "1762000000" would otherwise read as 1970.
function unixMs(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// accountOf turns one xiaohuanxiong2api account into the record the raccoon
// plugin reads (raccoon/index.mjs:867-881 toSuccessAuth, and :200-217
// readDesktopAuth), or says why it can't.
function accountOf(row, pluginId) {
  const access = stripBearer(str(row.access_token) || str(row.accessToken));
  if (!access) return { skip: "no access_token" };
  const claims = decodeJwtClaims(access);
  if (!claims) return { skip: "access_token isn't a JWT the vendor carries an identity in" };
  const refresh = str(row.refresh_token) || str(row.refreshToken);
  const uid = extractUserId(claims);
  const name = extractDisplayName(claims);
  // The vendor's own exp is what raccoon renews around; expires_at is
  // xiaohuanxiong2api's copy of it, used only when the token carries none.
  const fromToken = jwtExpiryMs(access);
  const expires = fromToken || unixMs(row.expires_at ?? row.expiresAt);
  if (expires && Date.now() >= expires && !refresh) {
    return { skip: "the token has expired and there is no refresh_token to renew it" };
  }
  const notes = [];
  if (fromToken && unixMs(row.expires_at ?? row.expiresAt) && Math.abs(fromToken - unixMs(row.expires_at ?? row.expiresAt)) > 60_000) {
    notes.push(`expires_at in accounts.json is ${new Date(unixMs(row.expires_at ?? row.expiresAt)).toISOString()}, ` +
      `the token's own exp ${new Date(fromToken).toISOString()} — the token's stands`);
  }
  if (!refresh) notes.push("no refresh_token: the account works until its access token ends, then needs a sign-in");
  const label = str(row.name) || name;
  return {
    auth: {
      type: "oauth",
      access,
      refresh,
      expires,
      uid,
      // accountId is the account's identity in magpie: what its per-account
      // settings hang off and what folds a duplicate (host.js whoOf/settle).
      // Same fallback raccoon uses at sign-in.
      accountId: label || (uid ? `Raccoon-${uid}` : PROVIDER_NAME),
      ...(name ? { name } : {}),
    },
    xhsId: str(row.id),
    uid,
    name: label,
    notes,
  };
}

function freshKey(all, provider) {
  if (!(provider in all)) return provider;
  for (;;) {
    const k = provider + "#" + Math.random().toString(36).slice(2, 8);
    if (!(k in all)) return k;
  }
}

// ---- magpie's file -----------------------------------------------------------

function magpieConfigDir(explicit) {
  if (explicit) return path.resolve(explicit);
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
    // host.js reads an all-zero or empty file as "unknown", not as "none" and
    // refuses to write over it; so does this.
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

// lockAuth mirrors host.js lockAuth(): the same lock file, wx 0600, one older
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

// sameAccount finds an entry already in the file that is this account, by the
// two things host.js settle() folds on: the secret (a refresh token, or the
// access one when there is none), and the uid. The name is deliberately not
// one of them: two people can be called the same thing, and folding them would
// silently drop an account. A token carrying neither a refresh token nor a uid
// that repeats therefore lands as a second entry rather than replacing the
// first — visible in `magpie accounts raccoon`, easy to delete.
function sameAccount(all, built) {
  return Object.keys(all).find((k) => {
    const a = all[k];
    if (!a || a.type !== "oauth") return false;
    if (built.refresh) {
      if (a.refresh === built.refresh) return true;
    } else if (a.access && a.access === built.access) {
      return true;
    }
    return !!built.uid && a.uid === built.uid;
  });
}

// ---- selftest ----------------------------------------------------------------

function selftest() {
  const jwt = "h." + Buffer.from(JSON.stringify({ exp: 1762000000, iss: "1f", name: "Mason", sub: "u-42" })).toString("base64url") + ".s";
  const c = decodeJwtClaims(jwt);
  if (jwtExpiryMs(jwt) !== 1762000000000) throw new Error(`selftest: exp read as ${jwtExpiryMs(jwt)}`);
  if (extractUserId(c) !== "31") throw new Error(`selftest: iss 1f should read as 31, gave ${extractUserId(c)}`);
  if (extractDisplayName(c) !== "Mason") throw new Error("selftest: name");
  const plain = "h." + Buffer.from(JSON.stringify({ sub: "u-42" })).toString("base64url") + ".s";
  if (extractUserId(decodeJwtClaims(plain)) !== "u-42") throw new Error("selftest: sub fallback");
  if (extractUserId(decodeJwtClaims("h." + Buffer.from(JSON.stringify({ user_id: "7" })).toString("base64url") + ".s")) !== "7") {
    throw new Error("selftest: user_id fallback");
  }
  if (extractUserId(decodeJwtClaims("h." + Buffer.from(JSON.stringify({ iss: "https://x.com/acme" })).toString("base64url") + ".s")) !== "") {
    throw new Error("selftest: a non-hex iss is not an id");
  }
  if (unixMs(1762000000) !== 1762000000000) throw new Error("selftest: seconds");
  if (unixMs(1762000000000) !== 1762000000000) throw new Error("selftest: ms");
  if (unixMs("") !== 0 || unixMs(null) !== 0) throw new Error("selftest: absent time reads as 0");
  const built = accountOf({ access_token: jwt, refresh_token: "R1", enabled: true }, DEFAULT_PLUGIN);
  if (built.auth?.accountId !== "Mason" || built.auth.uid !== "31") throw new Error("selftest: accountOf mapping");
  if (accountOf({ refresh_token: "R1" }, DEFAULT_PLUGIN).skip === undefined) throw new Error("selftest: a row with no token should be skipped");
  if (accountOf({ access_token: "not-a-jwt" }, DEFAULT_PLUGIN).skip === undefined) throw new Error("selftest: a non-JWT should be skipped");
  console.log("selftest ok: exp/uid/name read as raccoon reads them, times in ms, bad rows refused");
}

// ---- main --------------------------------------------------------------------

// say writes a human line to stdout, or to stderr when --json has stdout
// reserved for the report alone (so `... --json | jq` stays valid).
let humanToStderr = false;
function say(s = "") {
  (humanToStderr ? process.stderr : process.stdout).write(s + "\n");
}

// a reader that stops early (`| head`) is not an error
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e?.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(USAGE); return 0; }
  if (o.selftest) { selftest(); return 0; }
  humanToStderr = o.json;

  const accountsPath = o.accounts ? path.resolve(o.accounts) : defaultAccountsFile();
  const rows = readAccountsFile(accountsPath);
  if (!rows.length) throw new Error(`${accountsPath} holds no accounts`);

  const authPath = path.join(magpieConfigDir(o.magpieDir), "plugin-auth.json");
  const target = o.install ? authPath : path.resolve(o.out ?? "plugin-auth.import.json");
  const { all: existing } = o.install ? readExistingAuth(authPath) : { all: {} };

  // --sort decides which row gets the plain provider key: accountsOf puts that
  // one first, and magpie lists and tries the accounts in that order.
  const order = rows.map((row, i) => ({ row, i }));
  if (o.sort === "priority") {
    const pri = (r) => {
      const n = Number(r?.priority);
      return Number.isFinite(n) ? n : 100; // pool.go: default 100
    };
    order.sort((a, b) => pri(a.row) - pri(b.row) || a.i - b.i);
  }

  const out = { ...existing };
  const added = [];
  const skipped = [];
  const usedNames = new Set(Object.values(existing).map((a) => a?.accountId).filter(Boolean));

  for (const { row, i } of order) {
    const label = str(row?.name) || str(row?.id) || `#${i}`;
    // pool.go:61-63 — a row without "enabled" is enabled.
    if (row?.enabled === false && !o.includeDisabled) {
      skipped.push({ id: label, reason: 'disabled in accounts.json ("enabled": false)' });
      continue;
    }
    const built = accountOf(row ?? {}, o.plugin);
    if (built.skip) {
      skipped.push({ id: label, reason: built.skip });
      continue;
    }
    // magpie keeps on/off in logins.json, not in plugin-auth.json, and a
    // sign-in it finds there with no entry is added on (plugin_accounts.go) —
    // so a carried-over paused account arrives switched on.
    if (row?.enabled === false) {
      built.notes.push("paused in accounts.json: magpie will list it as in use — switch it off there, or leave it out");
    }
    const same = sameAccount(out, built.auth);
    if (same) {
      // Already there. Two cases worth telling apart: the same sign-in (leave
      // it), or accounts.json holding a NEWER token for the account magpie
      // already has — xiaohuanxiong2api renewed it after the import, which
      // spends the refresh token magpie holds. Taking the newer one over is
      // the only way magpie gets a working account back; leaving magpie's in
      // place would leave it renewing a token the vendor has already spent.
      const was = out[same];
      const newer = (built.auth.expires || 0) > (Number(was?.expires) || 0);
      if (newer) {
        const kept = { ...built.auth, accountId: was?.accountId || built.auth.accountId, ...(was?.name ? { name: was.name } : {}) };
        out[same] = kept;
        added.push({
          key: same, accountId: kept.accountId, name: built.name, uid: built.uid,
          xhsId: built.xhsId, expires: kept.expires, refresh: !!kept.refresh,
          replaced: true,
          notes: [...built.notes, `replaces the copy already there (it expired ${was?.expires ? new Date(Number(was.expires)).toISOString() : "never"}, this one ${kept.expires ? new Date(kept.expires).toISOString() : "never"})`],
        });
        continue;
      }
      skipped.push({ id: label, reason: `already in ${o.install ? authPath : "the output"} as ${same}`, existing: same });
      continue;
    }
    const key = freshKey(out, o.plugin);
    // Two accounts of one name are two accounts: the key's own suffix tells
    // them apart on the card, since accountId is what magpie names one by.
    if (usedNames.has(built.auth.accountId)) {
      const tail = key.split("#")[1] || String(i + 1);
      built.auth.accountId = `${built.auth.accountId} · ${tail}`;
      built.notes.push(`another account is already named "${built.name}": this one reads as "${built.auth.accountId}"`);
    }
    usedNames.add(built.auth.accountId);
    out[key] = built.auth;
    added.push({
      key, accountId: built.auth.accountId, name: built.name, uid: built.uid,
      xhsId: built.xhsId, expires: built.auth.expires, refresh: !!built.auth.refresh,
      notes: built.notes,
    });
  }

  // ---- report ----
  if (o.json) {
    console.log(JSON.stringify({ accounts: accountsPath, target: o.dryRun ? null : target, plugin: o.plugin, added, skipped }, null, 2));
  } else {
    const line = "─".repeat(72);
    say(`accounts  ${accountsPath}  (${rows.length} row${rows.length === 1 ? "" : "s"})`);
    say(`target    ${o.dryRun ? "(dry run, nothing written)" : target}`);
    say(`plugin    ${o.plugin}   sort ${o.sort}`);
    say(line);
    if (added.length) {
      say(`${added.length} account${added.length === 1 ? "" : "s"} to write:`);
      for (const a of added) {
        const exp = a.expires ? new Date(a.expires).toISOString().replace(".000Z", "Z") : "never";
        say(`  ${a.replaced ? "↻" : "✓"} ${a.key}${a.replaced ? "  (replacing the copy there)" : ""}`);
        say(`      ${a.accountId}${a.uid ? `  uid=${a.uid}` : ""}${a.xhsId ? `  (was ${a.xhsId})` : ""}`);
        say(`      expires=${exp}  refresh=${a.refresh ? "yes" : "no"}`);
        for (const n of a.notes) say(`      · ${n}`);
      }
    }
    if (skipped.length) {
      say(`\n${skipped.length} row${skipped.length === 1 ? "" : "s"} left alone:`);
      for (const s of skipped) say(`  – ${s.id}: ${s.reason}`);
    }
    say(line);
  }

  if (o.dryRun) return added.length ? 0 : 1;
  // --install with nothing to add still reports the file it left alone, and
  // says so with 0, the way durindoor-to-magpie.mjs does; without --install
  // there is nothing to write at all.
  if (!added.length && !o.install) return 1;

  // ---- write ----
  if (o.install) {
    const unlock = lockAuth(authPath);
    try {
      // read again under the lock: a host may have written since the report
      const { all: now, existed } = readExistingAuth(authPath);
      let changed = 0;
      for (const a of added) {
        const mine = out[a.key];
        if (now[a.key]) {
          // The key is taken. Only a renewal the host made meanwhile — newer
          // than what this run read — is left alone; anything else is a copy
          // this run means to replace.
          const theirs = Number(now[a.key]?.expires) || 0;
          if (!a.replaced || theirs > (Number(mine?.expires) || 0)) continue;
        }
        now[a.key] = mine;
        changed++;
      }
      if (!changed) {
        // nothing new: leave the file, and the mtime host.js caches a parse on
        say(`unchanged ${authPath} (${Object.keys(now).length} sign-in${Object.keys(now).length === 1 ? "" : "s"})`);
        return 0;
      }
      if (existed) {
        const bak = `${authPath}.pre-import-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        fs.copyFileSync(authPath, bak);
        say(`backup    ${bak}`);
      }
      writeDurable(authPath, Buffer.from(JSON.stringify(now, null, 2) + "\n"));
      say(`wrote     ${authPath} (${Object.keys(now).length} sign-in${Object.keys(now).length === 1 ? "" : "s"})`);
    } finally {
      unlock();
    }
  } else {
    writeDurable(target, Buffer.from(JSON.stringify(out, null, 2) + "\n"));
    say(`wrote     ${target}`);
  }

  const readBack = `  magpie accounts ${o.plugin} --json`;
  const logLine = "  magpie log";
  const col = Math.max(readBack.length, logLine.length) + 2;
  const pad = (s, note) => `\n${s}${" ".repeat(col - s.length)}${note}`;
  say(`
next:${o.install ? "" : "\n" + `  cp ${path.relative(process.cwd(), target)} ${authPath}   # or run again with --install`}${pad(readBack, "# the accounts read back")}${pad(logLine, "# a request going through them")}

Then take these accounts out of xiaohuanxiong2api's accounts.json. A Raccoon
refresh token is spent by whoever redeems it first: magpie's next refresh would
take it, and xiaohuanxiong2api's own refresh of the same entry would then fail.
The access tokens keep working on both sides until they expire.`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`error: ${e?.message ?? e}`);
  if (process.env.XHX_TO_MAGPIE_DEBUG) console.error(e);
  process.exitCode = 2;
}
