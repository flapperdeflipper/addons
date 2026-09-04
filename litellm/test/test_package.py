#!/usr/bin/env python3
"""Package tests for litellm-mcp.

Runs anywhere with plain python3 - no mcp SDK, pytest or network needed
(SDK imports are lazy; tools register against stubs).
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PKG_ROOT = os.path.join(ROOT, "mcp_servers")
sys.path.insert(0, PKG_ROOT)

from litellm_mcp.litellm_client import LitellmClient, truncate  # noqa: E402
from litellm_mcp.cli import register_builtin
from litellm_mcp.tools import REGISTRY  # noqa: E402


class StubServer:
    def __init__(self):
        self.tools = {}

    def tool(self):
        def decorator(fn):
            self.tools[fn.__name__] = fn
            return fn

        return decorator


class StubClient:
    """Records requests; answers like the real /v1/memory API."""

    def __init__(self, store=None):
        self.store = store if store is not None else {}
        self.requests = []

    def entry_path(self, key):
        return "/v1/memory/" + key

    def list_path(self, key_prefix=""):
        return "/v1/memory" + ("?key_prefix=" + key_prefix if key_prefix else "")

    def request(self, method, path, body=None):
        self.requests.append((method, path, body))
        if method == "GET" and path.startswith("/v1/memory?key_prefix="):
            prefix = path.split("key_prefix=", 1)[1]
            hits = [{"key": k, "value": v, "updated_at": "t"} for k, v in sorted(self.store.items()) if k.startswith(prefix)]
            return 200, {"memories": hits, "total": len(hits)}
        if method == "GET" and path == "/v1/memory":
            hits = [{"key": k, "value": v, "updated_at": "t"} for k, v in sorted(self.store.items())]
            return 200, {"memories": hits, "total": len(hits)}
        key = path.rsplit("/", 1)[-1]
        if method == "GET":
            if key not in self.store:
                return 404, {}
            return 200, {"key": key, "value": self.store[key], "metadata": None, "updated_at": "t"}
        if method == "PUT":
            self.store[key] = body["value"]
            return 200, {"key": key, "updated_at": "t"}
        if method == "DELETE":
            if key not in self.store:
                return 404, {}
            del self.store[key]
            return 200, {}
        return 405, {}

    def error(self, status, detail):
        return "error (HTTP %s): %s" % (status, detail)


def test_registry_and_registration():
    assert "memory" in REGISTRY, "memory tool must be registered"
    server, client = StubServer(), StubClient({"opencode:probe": "v"})
    REGISTRY["memory"].register(server, client)
    assert sorted(server.tools) == ["memory_delete", "memory_get", "memory_list", "memory_set"]


def test_tool_behaviour():
    server = StubServer()
    client = StubClient({"opencode:probe": "x" * 5000})
    REGISTRY["memory"].register(server, client)

    got = server.tools["memory_get"]("opencode:probe")
    assert "[truncated]" in got and got.count("x") < 5000, "long values must be truncated"
    assert server.tools["memory_get"]("missing") == "not found: missing"

    server.tools["memory_set"]("opencode:new", "val")
    assert client.store["opencode:new"] == "val", "set must upsert through the client"

    listed = server.tools["memory_list"]("opencode:")
    assert "opencode:new" in listed and "total" in listed

    server.tools["memory_delete"]("opencode:new")
    assert "opencode:new" not in client.store
    assert server.tools["memory_delete"]("opencode:new") == "not found: opencode:new"


def test_cli():
    env = dict(os.environ, PYTHONPATH=PKG_ROOT)
    ok = subprocess.run([sys.executable, "-m", "litellm_mcp", "--help"], env=env, capture_output=True, text=True)
    assert ok.returncode == 0 and "memory" in ok.stdout, "--help must work without the mcp SDK"
    bad = subprocess.run([sys.executable, "-m", "litellm_mcp", "bogus"], env=env, capture_output=True, text=True)
    assert bad.returncode != 0, "unknown tool names must be rejected"
    empty = subprocess.run([sys.executable, "-m", "litellm_mcp"], env=env, capture_output=True, text=True)
    assert empty.returncode != 0, "running with no tools must be rejected"
    listing = subprocess.run([sys.executable, "-m", "litellm_mcp", "--list"], env=env, capture_output=True, text=True)
    assert listing.returncode == 0 and "memory" in listing.stdout, "--list must print the catalog without the SDK"


def test_registry_list_discovery_tool():
    import json

    server, client = StubServer(), StubClient()
    REGISTRY["memory"].register(server, client)
    register_builtin(server, {"memory"})

    assert "registry_list" in server.tools, "the discovery tool must always be registered"
    catalog = json.loads(server.tools["registry_list"]())
    module = next(m for m in catalog["modules"] if m["name"] == "memory")
    assert module["enabled"] is True and module["description"]
    assert catalog["server"] == "litellm-mcp"


def test_client_paths_and_truncate():
    assert truncate("ab", 5) == "ab"
    client = LitellmClient("http://x/", "k")
    assert client.base_url == "http://x"
    assert client.entry_path("opencode:a:b") == "/v1/memory/opencode:a:b"
    assert client.list_path("opencode:") == "/v1/memory?key_prefix=opencode:"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok -", name)
            except AssertionError as err:
                failures += 1
                print("FAIL -", name, "-", err)
    print("%d failures" % failures)
    sys.exit(1 if failures else 0)
