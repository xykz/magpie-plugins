#!/usr/bin/env node
// raccoon-vendor-fixture.mjs — regenerate the Raccoon desktop app's wire
// values, the ones packages/raccoon/vendor-wire.mjs reproduces.
//
// The desktop app is an Electron build whose chat calls are made by a bundled
// CPython sidecar (`resources/box-agent-runtime/`), so what it puts on the
// wire is defined by Python code, not JavaScript. This script digs that code
// out of the app and runs it, and writes down what it says:
//
//   <zip>/resources/app.asar                      the Electron app (asar)
//     package.json                                name, version
//   <zip>/resources/box-agent-runtime/bin/box-agent-acp.exe
//                                                 the PyInstaller sidecar
//     PYZ.pyz                                     its Python archive
//
// Nothing here interprets those values. helper/raccoon-vendor-fixture.py
// executes the app's own functions and prints the result; this script only
// gets it there and writes the file. The exception is the two version strings
// recorded under `source`, which are read for provenance.
//
//   node helper/raccoon-vendor-fixture.mjs                    write the file
//   node helper/raccoon-vendor-fixture.mjs --check             compare only
//   node helper/raccoon-vendor-fixture.mjs --zip <path>        another build
//
// Needs CPython 3.12 on PATH (or PYTHON312 pointing at one): the app bundles
// 3.12.13, and marshal's format is not stable across minor versions. The
// interpreter is only needed to regenerate, never to run the tests.
//
// Exit codes: 0 ok, 1 --check found a difference, 2 usage or read error,
// 3 no CPython 3.12, 4 the app's code could not be located or executed.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const helper = dirname(fileURLToPath(import.meta.url))
const root = resolve(helper, "..")
const DEFAULT_ZIP = join(root, ".sandbox", "xhx.zip")
const DEFAULT_OUT = join(root, "packages", "raccoon", "testdata", "vendor-desktop-1.1.5.json")

const die = (code, message) => {
  process.stderr.write(message.replace(/\n?$/, "\n"))
  process.exit(code)
}

// ---- arguments --------------------------------------------------------------

let zipPath = DEFAULT_ZIP
let outPath = DEFAULT_OUT
let check = false
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === "--check") check = true
  else if (arg === "--zip") zipPath = resolve(process.argv[++i] ?? "")
  else if (arg === "--out") outPath = resolve(process.argv[++i] ?? "")
  else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: node helper/raccoon-vendor-fixture.mjs [--zip <xhx.zip>] [--out <file>] [--check]\n",
    )
    process.exit(0)
  } else die(2, `raccoon-vendor-fixture: unknown argument ${arg}`)
}

// ---- the archive ------------------------------------------------------------

// An asar starts with two Chromium pickles:
//   u32 @0  4                 the size of the field that follows
//   u32 @4  headerSize        the directory pickle's length
//   u32 @8  headerSize - 4    its own string field's size
//   u32 @12 jsonLength        the JSON's length
//   @16     the JSON, padded to a 4-byte boundary
// and the files' bytes begin at base = 8 + headerSize, where that headerSize
// already accounts for the padding. Reading the JSON to `base` rather than to
// 16 + jsonLength is what keeps the two in step.
function asarDirectory(fd) {
  const headerSize = fd.readUInt32LE(4)
  const base = 8 + headerSize
  if (headerSize <= 8 || base > fd.length)
    die(2, "raccoon-vendor-fixture: the asar header looks wrong")
  const text = fd.subarray(16, base).toString("utf8").replace(/\0+$/, "")
  try {
    return { dir: JSON.parse(text), base }
  } catch (error) {
    die(2, `raccoon-vendor-fixture: the asar directory is not JSON: ${error.message}`)
  }
}

function asarEntry(fd, path) {
  const { dir, base } = asarDirectory(fd)
  let node = dir
  for (const part of path.split("/")) {
    node = node?.files?.[part]
    if (!node) return null
  }
  if (node.files) return null
  const at = base + Number(node.offset ?? 0)
  return fd.subarray(at, at + Number(node.size ?? 0))
}

// PyInstaller ends its executables with an 88-byte cookie, big-endian:
//   magic[8] pkglen u32 @8 tocoff u32 @12 toclen u32 @16 pyver u32 @20 pylib[64] @24
// The archive it describes starts at cookie + 88 - pkglen, and PYZ.pyz (the
// compiled Python) sits in it. The PYZ is then found by its own magic: its
// header is self-describing, so this does not depend on the archive's table
// entry layout, which differs between PyInstaller versions.
const PYINSTALLER_MAGIC = Buffer.from("MEI\x0c\x0b\x0a\x0b\x0e", "latin1")
const COOKIE_SIZE = 88
const PYZ_MAGIC = Buffer.from("PYZ\0", "latin1")

function findPyz(exe) {
  const cookieAt = exe.lastIndexOf(PYINSTALLER_MAGIC)
  if (cookieAt < 0 || cookieAt + COOKIE_SIZE > exe.length)
    die(2, "raccoon-vendor-fixture: the sidecar has no PyInstaller cookie")
  const pkglen = exe.readUInt32BE(cookieAt + 8)
  const pyver = exe.readUInt32BE(cookieAt + 20)
  const pylib = exe.subarray(cookieAt + 24, cookieAt + 24 + 64).toString("latin1").replace(/\0.*$/, "")
  const archiveStart = cookieAt + COOKIE_SIZE - pkglen
  if (archiveStart < 0 || archiveStart > cookieAt)
    die(2, "raccoon-vendor-fixture: the sidecar's archive length is out of range")
  const at = exe.indexOf(PYZ_MAGIC, archiveStart)
  if (at < 0 || at > cookieAt) die(2, "raccoon-vendor-fixture: no PYZ in the sidecar")
  const pyz = exe.subarray(at, cookieAt)
  // sanity: the table's offset must land inside what we took
  const tocOffset = pyz.readUInt32BE(8)
  if (tocOffset <= 0 || tocOffset >= pyz.length)
    die(2, "raccoon-vendor-fixture: the PYZ in the sidecar is not complete")
  return { pyz, pyver, pylib }
}

// ---- main -------------------------------------------------------------------

if (!existsSync(zipPath)) {
  die(
    2,
    `raccoon-vendor-fixture: ${zipPath} is not there.\n` +
      "  The desktop build is not in the repo (it is large, and .sandbox/ is ignored).\n" +
      "  Get one and pass it with --zip, or drop it at .sandbox/xhx.zip.",
  )
}

const zip = readFileSync(zipPath)
const zipSha = createHash("sha256").update(zip).digest("hex")

// unzip one member without staging the whole 546 MB file; the asar and the
// sidecar are both far larger than the zip's own directory, so the standard
// tool is the reliable one here.
function unzipMember(member) {
  const result = spawnSync("unzip", ["-p", zipPath, member], { maxBuffer: 1 << 30 })
  if (result.status !== 0 || !result.stdout?.length)
    die(
      2,
      `raccoon-vendor-fixture: cannot read ${member} from the zip: ` +
        (result.stderr?.toString().trim() || `unzip exited ${result.status}`),
    )
  return result.stdout
}

const appAsar = unzipMember("resources/app.asar")
const exe = unzipMember("resources/box-agent-runtime/bin/box-agent-acp.exe")

const appPackage = asarEntry(Buffer.from(appAsar), "package.json")
if (!appPackage) die(2, "raccoon-vendor-fixture: the asar has no package.json")
const app = JSON.parse(appPackage.toString("utf8"))

const runtimeVersion = (() => {
  const v = unzipMember("resources/box-agent-runtime/VERSION")
  return v.toString("utf8").trim()
})()

// The interpreter the app bundles, as its own DLL spells it (34 occurrences of
// one 3.12.x string). X-Stainless-Runtime-Version has to be this, not whatever
// the extractor happens to run under.
const bundledPython = (() => {
  const dll = unzipMember("resources/box-agent-runtime/bin/_internal/python312.dll").toString("latin1")
  const found = new Set(dll.match(/3\.12\.\d+/g) ?? [])
  if (found.size !== 1)
    die(
      2,
      `raccoon-vendor-fixture: python312.dll names ${found.size} versions` +
        (found.size ? ` (${[...found].join(", ")})` : "") +
        ", expected exactly one",
    )
  return [...found][0]
})()

const { pyz, pyver, pylib } = findPyz(exe)
if (pyver !== 312)
  die(2, `raccoon-vendor-fixture: the sidecar holds Python ${pyver}, expected 312 (3.12)`)
if (!bundledPython.startsWith("3.12."))
  die(2, `raccoon-vendor-fixture: the bundled Python is ${bundledPython}, expected 3.12.x`)

// ---- run the app's code -----------------------------------------------------

// A candidate has to be probed, not just found: a version-manager shim for a
// name nobody installed exists and exits non-zero with its own message, which
// would otherwise be reported as the extractor's failure.
function python312(candidate) {
  const probe = spawnSync(candidate, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
    encoding: "utf8",
  })
  if (probe.error?.code === "ENOENT") return null
  if (probe.status !== 0) return null
  return probe.stdout.trim() === "3.12" ? candidate : null
}

const candidates = [process.env.PYTHON312, "python3.12", "python3"]
  .filter(Boolean)
  .map(python312)
  .filter(Boolean)
if (!candidates.length) {
  die(
    3,
    "raccoon-vendor-fixture: no CPython 3.12 found (tried " +
      [process.env.PYTHON312, "python3.12", "python3"].filter(Boolean).join(", ") +
      ").\n  The app bundles 3.12.13, and marshal's format is not stable across\n" +
      "  minor versions. Set PYTHON312 to a 3.12 interpreter.",
  )
}

const python = candidates[0]
const result = spawnSync(python, [join(helper, "raccoon-vendor-fixture.py"), bundledPython], {
  input: pyz,
  maxBuffer: 1 << 28,
})
if (result.status !== 0) {
  process.stderr.write(result.stderr?.toString() ?? "")
  die(result.status ?? 2, `raccoon-vendor-fixture: the extractor failed under ${python}`)
}
const ran = { python, out: result.stdout.toString() }

let values
try {
  values = JSON.parse(ran.out)
} catch (error) {
  die(4, `raccoon-vendor-fixture: the extractor did not print JSON: ${error.message}`)
}

// ---- write ------------------------------------------------------------------

const fixture = {
  ...values,
  source: {
    ...values.source,
    appName: app.name,
    runtimeVersion,
    pylib,
    zipSha256: zipSha,
    zip: zipPath.slice(root.length + 1) || zipPath,
  },
  // where every value above came from, so a later reader can re-derive rather
  // than trust: the app's own functions, executed by the extractor.
  _provenance: {
    generator: "helper/raccoon-vendor-fixture.mjs",
    extractor: "helper/raccoon-vendor-fixture.py",
    runs: "the app's own bytecode: openai._base_client.platform_headers, box_agent.client_info.ClientInfo.headers_for_url, box_agent.llm.base._agent_headers, box_agent.llm.openai_client._apply_thinking_params",
  },
}

const rendered = JSON.stringify(fixture, null, 2) + "\n"

if (check) {
  if (!existsSync(outPath))
    die(1, `raccoon-vendor-fixture: ${outPath} is missing; run without --check to write it`)
  const have = readFileSync(outPath, "utf8")
  if (have === rendered) {
    process.stdout.write(`raccoon-vendor-fixture: ${outPath} matches the app\n`)
    process.exit(0)
  }
  const haveLines = have.trimEnd().split("\n")
  const wantLines = rendered.trimEnd().split("\n")
  const at = haveLines.findIndex((line, i) => line !== wantLines[i])
  const around = (lines) => lines.slice(Math.max(0, at - 2), at + 3).join("\n")
  die(
    1,
    `raccoon-vendor-fixture: ${outPath} is out of step with the app (first difference at line ${at + 1})\n` +
      `  in the file:\n${around(haveLines)}\n  the app now says:\n${around(wantLines)}\n` +
      "  Review the difference, then rerun without --check to accept it.",
  )
}

writeFileSync(outPath, rendered)
process.stdout.write(
  `raccoon-vendor-fixture: wrote ${outPath}\n` +
    `  from ${fixture.source.zip} (sha256 ${zipSha.slice(0, 12)}…), ${ran.python}\n` +
    `  ${fixture.source.appName} ${fixture.source.appVersion}, runtime ${runtimeVersion}\n`,
)
