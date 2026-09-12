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

    def with_key(self, api_key):
        return self if not api_key else self


class StubAdminClient(StubClient):
    """Answers the admin endpoints the admin module calls."""

    def __init__(self):
        super().__init__()
        self.posts = []

    def request(self, method, path, body=None):
        self.requests.append((method, path, body))
        if method == "GET" and path.startswith("/v1/tool/list"):
            wanted = path.split("input_policy=", 1)[1] if "input_policy=" in path else ""
            rows = [
                {"tool_name": "a", "input_policy": "untrusted", "output_policy": "untrusted", "call_count": 3},
                {"tool_name": "b", "input_policy": "trusted", "output_policy": "untrusted", "call_count": 4},
            ]
            if wanted:
                rows = [r for r in rows if r["input_policy"] == wanted]
            return 200, {"tools": rows, "total": len(rows)}
        if method == "POST" and path == "/v1/tool/policy":
            self.posts.append(body)
            return 200, {"tool_name": body.get("tool_name"), "updated": True}
        if method == "GET" and path == "/v1/models":
            return 200, {"data": [{"id": "stub-model-a"}, {"id": "stub-model-b"}]}
        if method == "GET" and path == "/key/list":
            return 200, {"keys": [{"key_alias": "home-assist-2", "token": "hash", "expires": None, "blocked": False}]}
        if method == "GET" and path.startswith("/spend/logs/ui"):
            return 200, {
                "data": [
                    {"startTime": "t1", "model_group": "stub-model-a", "metadata": {"status": "success"}},
                    {
                        "startTime": "t2",
                        "model_group": "stub-model-a",
                        "metadata": {
                            "status": "failure",
                            "user_api_key_alias": "home-assist-2",
                            "error_information": {"error_message": "400: Violated tool policy " + "x" * 400},
                        },
                    },
                ],
                "total": 2,
            }
        return super().request(method, path, body)


def test_registry_and_registration():
    assert "memory" in REGISTRY, "memory tool must be registered"
    assert "admin" in REGISTRY, "admin tool must be registered"
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


def test_admin_registration_and_catalog():
    import json

    server, client = StubServer(), StubAdminClient()
    REGISTRY["admin"].register(server, client)
    expected = [
        "admin_failed_requests",
        "admin_keys",
        "admin_models",
        "admin_tool_policy_list",
        "admin_tool_policy_set",
    ]
    assert sorted(server.tools) == expected

    policies = json.loads(server.tools["admin_tool_policy_list"]())
    assert policies["total"] == 2 and policies["tools"][0]["tool"] == "a"
    filtered = json.loads(server.tools["admin_tool_policy_list"]("trusted"))
    assert filtered["total"] == 1 and filtered["tools"][0]["tool"] == "b"
    assert "invalid input_policy" in server.tools["admin_tool_policy_list"]("bogus")

    models = json.loads(server.tools["admin_models"]())
    assert models["models"] == ["stub-model-a", "stub-model-b"], "ids must extract in order"
    assert models["total"] == 2


def test_admin_tool_policy_set_validation_and_post():
    import json

    server, client = StubServer(), StubAdminClient()
    REGISTRY["admin"].register(server, client)
    set_policy = server.tools["admin_tool_policy_set"]

    assert "provide input_policy" in set_policy("a")
    assert "invalid input_policy" in set_policy("a", input_policy="bogus")
    assert "invalid output_policy" in set_policy("a", output_policy="bogus")
    assert not client.posts, "invalid calls must not reach the proxy"

    resp = json.loads(set_policy("a", input_policy="untrusted"))
    assert resp["updated"] is True
    assert client.posts == [{"tool_name": "a", "input_policy": "untrusted"}]

    set_policy("b", input_policy="blocked", team_id="t1")
    assert client.posts[-1] == {"tool_name": "b", "input_policy": "blocked", "team_id": "t1"}


def test_admin_keys_never_leak_tokens():
    import json

    server, client = StubServer(), StubAdminClient()
    REGISTRY["admin"].register(server, client)
    out = server.tools["admin_keys"]()
    assert "hash" not in out and "token" not in out, "token values must never be returned"
    keys = json.loads(out)
    assert keys["keys"][0]["alias"] == "home-assist-2"


def test_admin_failed_requests_filters_and_truncates():
    import json

    server, client = StubServer(), StubAdminClient()
    REGISTRY["admin"].register(server, client)
    out = server.tools["admin_failed_requests"](24)
    summary = json.loads(out)
    assert summary["scanned"] == 2 and summary["shown"] == 1
    failure = summary["failures"][0]
    assert failure["key"] == "home-assist-2" and failure["model"] == "stub-model-a"
    assert len(failure["error"]) < 400 and "[truncated]" in failure["error"]
    assert "start_date=" in client.requests[-1][1] and "page_size=100" in client.requests[-1][1]


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
