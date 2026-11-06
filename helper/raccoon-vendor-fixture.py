#!/usr/bin/env python3
# raccoon-vendor-fixture.py — run the Raccoon desktop app's own code to get the
# values its chat requests carry, and print them as JSON.
#
# Invoked by helper/raccoon-vendor-fixture.mjs, which hands us the app's
# Python archive on stdin and the interpreter version the app bundles on the
# command line. Everything printed here comes from executing the app's own
# bytecode — no value is read off a comment or guessed, and no constant is
# folded by re-implementing what CPython would have done.
#
# What is executed, and where it lives in the app:
#   …/openai/_base_client.py
#     platform_headers(version, *, platform)            the X-Stainless-* set
#     get_platform / get_architecture                   the OS and arch it reads
#     OtherArch.__str__ / OtherPlatform.__str__          "other:<name>" for a
#                                                       machine it can't map
#   …/box_agent/client_info.py
#     ClientInfo.headers_for_url(url)                   the x-client-* set
#   …/box_agent/llm/base.py
#     _agent_headers(session_id, turn_id, title, call_kind)
#                                                       the X-RACCOON-* set
#   …/box_agent/llm/openai_client.py
#     _apply_thinking_params(params, *, model, thinking_enabled,
#                            reasoning_effort_when_disabled)
#                                                       how thinking is asked for
#
# How each module is run, and why it differs:
#   openai_client and client_info are exec'd whole. Their imports are stubbed
#   (see Installer) because the archive holds no C extensions, but everything
#   that decides a value — re, os, the module's own constants — is the real
#   thing. An early version stubbed those too and every model silently took
#   the wrong branch, which is exactly the failure this file exists to avoid.
#   _base_client is not exec'd whole: it is a large module of pydantic models
#   whose import fails deep inside pydantic. The four functions that decide
#   the headers are rebuilt instead, given only the globals they name.
#
# The interpreter must be CPython 3.12 (the app bundles 3.12.13, read from
# _internal/python312.dll). marshal's format is not stable across minor
# versions, so another 3.12.x is fine and 3.13 is not.
#
#   node helper/raccoon-vendor-fixture.mjs            (uses this)
#   PYTHON312=python3.12 python raccoon-vendor-fixture.py 3.12.13 < PYZ.pyz
#
# Exit codes: 0 ok, 2 usage or read error, 3 interpreter is not CPython 3.12,
# 4 the app's code could not be located or executed.

import builtins
import importlib.util
import json
import marshal
import os
import re
import struct
import sys
import types
import zlib


def die(code, message):
    sys.stderr.write(message.rstrip() + "\n")
    sys.exit(code)


if sys.version_info[:2] != (3, 12):
    die(
        3,
        "raccoon-vendor-fixture: needs CPython 3.12 (the app bundles 3.12.13), "
        "this is %s.%s. Set PYTHON312 to a 3.12 interpreter."
        % sys.version_info[:2],
    )

# the version the app bundles, so X-Stainless-Runtime-Version is the app's and
# not the extractor's; the .mjs reads it out of python312.dll
BUNDLED_PYTHON = sys.argv[1] if len(sys.argv) > 1 else "3.12.13"
if not re.fullmatch(r"3\.12\.\d+", BUNDLED_PYTHON):
    die(2, "raccoon-vendor-fixture: expected the app's Python version, got %r" % BUNDLED_PYTHON)


# ── the archive ──────────────────────────────────────────────────────────────

raw = sys.stdin.buffer.read()
if not raw.startswith(b"PYZ\0"):
    die(2, "raccoon-vendor-fixture: stdin is not a PYZ archive")

_, toc_offset = struct.unpack("!II", raw[4:12])
try:
    # a list of (name, (is_package, offset, length)); offsets are from the
    # archive's first byte, as the module data below reads them
    table = marshal.loads(raw[toc_offset:])
except Exception as exc:  # noqa: BLE001 - the message is the value here
    die(2, "raccoon-vendor-fixture: cannot read the archive's table: %s" % exc)

MODULES = {name: (packaged, offset, length) for name, (packaged, offset, length) in table}


def code_of(module):
    """The module's code object, decompressed out of the archive."""
    try:
        _, offset, length = MODULES[module]
    except KeyError:
        die(4, "raccoon-vendor-fixture: the archive has no %s" % module)
    try:
        return marshal.loads(zlib.decompress(raw[offset : offset + length]))
    except Exception as exc:  # noqa: BLE001
        die(4, "raccoon-vendor-fixture: cannot read %s: %s" % (module, exc))


def walk(co):
    """Every code object under `co`, the module's own first."""
    yield co
    for const in co.co_consts:
        if hasattr(const, "co_code"):
            yield from walk(const)


def find(module, name, accept=None):
    """A function or class body by name, wherever it sits.

    _agent_headers is a method of LLMClientBase, not a module-level name, so a
    plain co_consts scan misses it; walk covers both. A name can also be
    defined twice — platform_headers exists as BaseClient's method and as the
    module-level function it calls — so `accept` picks the right one rather
    than taking whichever comes first in the module.
    """
    seen = []
    for co in walk(code_of(module)):
        if co.co_name != name:
            continue
        seen.append(co)
        if accept is None or accept(co):
            return co
    die(
        4,
        "raccoon-vendor-fixture: %s has no %s%s (found %d)"
        % (module, name, " matching the expected shape" if accept else "", len(seen)),
    )


def takes(module, name, *params):
    """find(), for the definition whose parameters are exactly `params`."""
    return find(
        module,
        name,
        lambda co: co.co_varnames[: co.co_argcount + co.co_kwonlyargcount] == params,
    )


# ── running a module out of the archive ─────────────────────────────────────


class _Stub:
    """Stands in for a third-party name the archive can only half provide.

    The archive has no compiled extensions, so pydantic_core (and with it
    pydantic) cannot import. A stub answers every attribute and call with
    another stub, which is enough for the module-level *definitions* to run;
    nothing that decides a value goes through one. Stdlib never reaches here.
    """

    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        return _Stub()

    def __call__(self, *args, **kwargs):
        return _Stub()

    def __getitem__(self, key):
        return _Stub()

    def __iter__(self):
        return iter(())

    def __or__(self, other):
        return _Stub()

    def __mro_entries__(self, bases):
        return (object,)


class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Stub()


# the third-party roots that cannot load without a compiled extension, plus
# the packages that import them. Everything else — the stdlib above all — is
# imported for real.
_STUB_ROOTS = (
    "pydantic",
    "pydantic_core",
    "typing_extensions",
    "annotated_types",
    "httpx",
    "httpcore",
    "anyio",
    "jiter",
    "tiktoken",
    "openai",
    "anthropic",
    "retry",
    "sniffio",
    "certifi",
    "idna",
    "h11",
)


def _stubbed_import(name, globals=None, locals=None, fromlist=(), level=0):
    """__import__ for a module we exec: stdlib real, the rest stubbed.

    Two things have to be real or the results are silently wrong. The stdlib,
    because a stubbed `re` matches every string and so takes every branch
    (that happened: every model came back `low`). And the module's own
    constants, which is the whole reason this file exec's a module instead of
    reading values off a comment.

    Third-party packages are stubbed — the archive holds no compiled
    extensions, so pydantic and openai cannot load. Nothing recorded here is
    decided by one of them: they only provide types in annotations.

    Relative imports resolve to stubs too. openai_client imports `base` and
    `schema` and `client_info`, and where one of those functions is actually
    needed it is reached through find() rather than through the import.
    """
    if level:
        package = (globals or {}).get("__package__") or ""
        parts = package.split(".") if package else []
        if level > 1:
            parts = parts[: len(parts) - (level - 1)]
        name = ".".join(parts + ([name] if name else ""))

    if name in sys.modules:
        return sys.modules[name]

    top = name.split(".")[0]
    if top in getattr(sys, "stdlib_module_names", frozenset()) and top not in _STUB_ROOTS:
        try:
            return builtins.__import__(name, globals, locals, fromlist, level)
        except ImportError:
            pass

    module = _StubModule(name)
    sys.modules[name] = module
    return module


def run_module(name):
    """Exec a module from the archive and return it, fully run."""
    if name in sys.modules and getattr(sys.modules[name], "__raccoon_archive__", False):
        return sys.modules[name]
    builtins_map = dict(vars(builtins))
    builtins_map["__import__"] = _stubbed_import
    module = types.ModuleType(name)
    module.__file__ = "<archive:%s>" % name
    module.__builtins__ = builtins_map
    module.__raccoon_archive__ = True
    sys.modules[name] = module
    try:
        exec(code_of(name), module.__dict__)  # noqa: S102
    except Exception as exc:  # noqa: BLE001
        die(4, "raccoon-vendor-fixture: cannot run %s: %s: %s" % (name, type(exc).__name__, exc))
    return module


# ── openai's own header set ──────────────────────────────────────────────────


class _Other:
    """OtherArch / OtherPlatform, rebuilt from their code objects.

    Their __str__ is "other:<name>" — an arch or OS the SDK has no mapping for
    still names itself, which is why a Windows AMD64 reports "other:amd64".
    """

    def __init__(self, name):
        self.name = name

    def __str__(self):
        return "other:" + self.name


class _Distro:
    """`distro`, as far as get_platform needs it: id().

    get_platform asks it one question only — FreeBSD, OpenBSD, or (anything
    else) Linux. The archive's real distro is a package whose __init__ does a
    relative import that cannot run outside a package context, and a Windows
    or macOS host never consults it anyway.
    """

    def __init__(self, distro_id):
        self._id = distro_id

    def id(self):
        return self._id


class HostPlatform:
    """A `platform` module for one host: the answers the SDK's probes read."""

    def __init__(self, system, machine, release, python_version=BUNDLED_PYTHON):
        self._system = system
        self._machine = machine
        self._release = release
        self._python_version = python_version

    def system(self):
        return self._system

    def platform(self):
        return "%s-%s" % (self._system, self._release)

    def machine(self):
        return self._machine

    def python_implementation(self):
        return "CPython"

    def python_version(self):
        return self._python_version


def sdk_platform_headers(platform, version, distro_id=None):
    """platform_headers(version, platform=None) as the app's SDK computes it.

    Rebuilt rather than exec'd: _base_client is pydantic models throughout and
    will not import. The four functions it goes through are all it needs, and
    `platform` is swapped so a Windows host can be asked about from Linux.
    """
    g = {
        "sys": sys,
        "distro": _Distro(distro_id or "ubuntu"),
        "OtherArch": _Other,
        "OtherPlatform": _Other,
        "platform": platform,
    }
    for name in ("get_platform", "get_architecture", "get_python_runtime", "get_python_version"):
        g[name] = types.FunctionType(find("openai._base_client", name), g)
    # the module-level one, not BaseClient's method of the same name
    g["platform_headers"] = types.FunctionType(
        takes("openai._base_client", "platform_headers", "version", "platform"), g
    )
    return g["platform_headers"](version, platform=None)


# ── box_agent's own header sets ─────────────────────────────────────────────

# The client identity the desktop sends: @raccoon/office-desktop 1.1.5,
# channel official. No device id: the app's client_info carries none, and a
# blank one drops that header entirely.
CLIENT_NAME = "@raccoon/office-desktop"
CLIENT_VERSION = "1.1.5"
CLIENT_CHANNEL = "official"
CHAT_URL = "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions"

HOSTS = [
    # key               system     machine    release       distro id
    ("windows-x64", "Windows", "AMD64", "10.0.22631", None),
    ("windows-arm64", "Windows", "ARM64", "10.0.22631", None),
    ("macos-arm64", "Darwin", "arm64", "25.2.0", None),
    ("macos-x64", "Darwin", "x86_64", "25.2.0", None),
    ("linux-x64", "Linux", "x86_64", "6.8.0", "ubuntu"),
    ("linux-arm64", "Linux", "aarch64", "6.8.0", "ubuntu"),
]

# One model per branch of _apply_thinking_params, plus the sense-nova
# whitelisted one (only that exact id takes the `low` branch, not every
# sense-nova model) and a plain model for the fall-through.
MODELS = [
    "sn-deepseek-v4-1-flash",
    "doubao-seed-1-6",
    "qwen3-max",
    "sn-kimi-k3",
    "sn-glm-5-3",
    "gemini-2.5-pro",
    "gemini-3-pro",
    "gpt-6-sol",
    "sn-sensenova-6-8-flash-lite",
    "sensenova-flash-lite-20260727-v39-fp8-step4k-dpov2-mtp",
    "unmatched-model",
]


def agent_headers(session_id, turn_id, title, call_kind):
    """_agent_headers: the four X-RACCOON-* headers, empty values dropped."""
    fn = types.FunctionType(find("box_agent.llm.base", "_agent_headers"), {"str": str})
    return fn(session_id, turn_id, title, call_kind)


def thinking_module():
    """box_agent.llm.openai_client, exec'd whole.

    It imports pydantic (stubbed) and reads re/os for real, and its constants
    come out of the execution rather than out of a hand-written fold: an
    earlier fold got _SENSENOVA_LOW_DEFAULT_MODELS wrong and nothing said so.
    """
    return run_module("box_agent.llm.openai_client")


def on_wire(params):
    """The body as the SDK sends it, thinking keys only.

    The params dict is not the wire body: `extra_body` is a container the SDK
    lifts into `extra_json` and merges into the body at the top level. So one
    level of it disappears in transit — `params['extra_body']` holding
    `{'thinking': …}` arrives as a top-level `thinking`, and `_litellm_extra_body`
    wrapping it one deeper (its own `extra_body` key) is what makes the wire
    show `extra_body.thinking` at all. Merging, not copying, is the whole
    transformation.
    """
    body = {k: v for k, v in params.items() if k != "extra_body"}
    body.update(params.get("extra_body") or {})
    return {k: body[k] for k in ("extra_body", "enable_thinking", "reasoning_effort") if k in body}


def main():
    sdk_version = next(
        (c for c in code_of("openai._version").co_consts
         if isinstance(c, str) and re.fullmatch(r"\d+\.\d+\.\d+", c)),
        "unknown",
    )

    client_info = run_module("box_agent.client_info")

    headers = {"stainless": {}, "clientInfo": {}}
    for key, system, machine, release, distro_id in HOSTS:
        headers["stainless"][key] = sdk_platform_headers(
            HostPlatform(system, machine, release), sdk_version, distro_id
        )
        os_name = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}[system]
        # the names the app's own platform string uses: the OS's machine()
        # spelling, folded to x64 / arm64 / x86
        arch_name = {
            "AMD64": "x64",
            "ARM64": "arm64",
            "x86_64": "x64",
            "aarch64": "arm64",
            "arm64": "arm64",
        }[machine]
        headers["clientInfo"][key] = client_info.ClientInfo(
            name=CLIENT_NAME,
            platform="desktop-%s-%s" % (os_name, arch_name),
            version=CLIENT_VERSION,
            os_version=release,
            channel=CLIENT_CHANNEL,
        ).headers_for_url(CHAT_URL)

    headers["agent"] = agent_headers(
        "00000000-0000-4000-8000-000000000000",
        "00000000-0000-4000-8000-000000000000",
        "a title",
        "chat",
    )

    openai_client = thinking_module()
    apply_thinking = openai_client._apply_thinking_params

    def ask(model, enabled, tools=None):
        params = {
            "messages": [{"role": "user", "content": "hi"}],
            "max_tokens": 80000,
            "model": model,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            params["tools"] = tools
        apply_thinking(
            params,
            model=model,
            thinking_enabled=enabled,
            reasoning_effort_when_disabled=None,
        )
        return on_wire(params)

    thinking = {
        model: {"on": ask(model, True), "off": ask(model, False)} for model in MODELS
    }

    # the branch that needs a tool to reach: a gpt-6 family model turns
    # thinking off outright when the request carries function tools, whatever
    # thinking_enabled said
    thinking["gpt-6-sol|tools"] = {
        "on": ask("gpt-6-sol", True, tools=[{"type": "function", "function": {"name": "noop"}}]),
    }

    out = {
        "schema": 1,
        "source": {
            "appVersion": CLIENT_VERSION,
            "clientName": CLIENT_NAME,
            "bundledPython": BUNDLED_PYTHON,
            "extractorPython": "%d.%d.%d" % sys.version_info[:3],
            "openaiSdk": sdk_version,
        },
        "chatUrl": CHAT_URL,
        "headers": headers,
        "thinking": thinking,
    }
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
