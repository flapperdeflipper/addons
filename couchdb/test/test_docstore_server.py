#!/usr/bin/env python3
"""Self-running tests for the docstore MCP dispatch layer (stdlib only).

CouchDB is faked; nothing touches the network.
Run: python3 test/test_docstore_server.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "docstore"))

from server import DocstoreServer, check_token, resolve_credentials  # noqa: E402

REGISTRY = {
    "databases": ["agent_handoffs", "agent_tasks", "agent_memory"],
    "types": {
        "handoff": {"db": "agent_handoffs", "id_pattern": r"^handoff/\d{4}-\d{2}-\d{2}-[a-z0-9-]+$", "ttl_days": 90},
        "task": {"db": "agent_tasks", "id_pattern": r"^task/[a-z0-9-]+/[a-z0-9-]+$", "ttl_days": 30, "ttl_from": "done"},
        "dossier": {"db": "agent_memory", "id_pattern": r"^dossier/[a-z0-9-]+$"},
    },
}


class FakeCouch:
    def __init__(self, docs=None):
        self.docs = dict(docs or {})
        self.puts = []
        self.deletes = []

    def get(self, db, doc_id):
        doc = self.docs.get((db, doc_id))
        if doc is None:
            raise LookupError(f"{doc_id} not found in {db}")
        return dict(doc)

    def put(self, db, doc_id, doc):
        self.puts.append((db, doc_id, doc))
        rev = f"rev-{len(self.puts)}"
        stored = dict(doc, _id=doc_id, _rev=rev)
        self.docs[(db, doc_id)] = stored
        return stored

    def delete(self, db, doc_id, rev):
        self.deletes.append((db, doc_id, rev))
        self.docs.pop((db, doc_id), None)

    def find(self, db, mango):
        out = []
        for (bdb, doc_id), doc in self.docs.items():
            if bdb != db or not _matches(doc, mango.get("selector", {})):
                continue
            out.append(dict(doc))
        out.sort(key=lambda d: d["_id"])
        return out[: mango.get("limit", 25)]


def _matches(doc, selector):
    for key, cond in selector.items():
        value = doc.get(key)
        if isinstance(cond, dict):
            for op, operand in cond.items():
                if op == "$lte" and not (value is not None and value <= operand):
                    return False
        elif value != cond:
            return False
    return True


def make_server(couch):
    from core import Registry

    return DocstoreServer(Registry.parse(REGISTRY), couch)


def call(server, method, params=None, msg_id=1):
    return server.handle({"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}})


def tool(server, name, args, msg_id=1):
    return call(server, "tools/call", {"name": name, "arguments": args}, msg_id)


def text(result):
    assert result.get("result") is not None, result
    return result["result"]["content"][0]["text"]


class TestToken(unittest.TestCase):
    def test_accepts_correct_bearer(self):
        self.assertTrue(check_token("Bearer s3cret", "s3cret"))

    def test_rejects_wrong_or_malformed(self):
        self.assertFalse(check_token("Bearer wrong", "s3cret"))
        self.assertFalse(check_token("s3cret", "s3cret"))
        self.assertFalse(check_token("", "s3cret"))
        self.assertFalse(check_token("Bearer s3cret", ""))


class TestToolsList(unittest.TestCase):
    def test_lists_docstore_tools(self):
        result = call(make_server(FakeCouch()), "tools/list")
        names = {t["name"] for t in result["result"]["tools"]}
        self.assertEqual(
            names,
            {"doc_get", "doc_put", "doc_update", "doc_delete", "doc_query", "task_claim", "task_complete"},
        )
        for t in result["result"]["tools"]:
            self.assertIn("description", t)
            self.assertIn("inputSchema", t)

    def test_unknown_method(self):
        result = call(make_server(FakeCouch()), "wat/do")
        self.assertEqual(result["error"]["code"], -32601)


class TestDocPut(unittest.TestCase):
    def test_create_round_trip(self):
        couch = FakeCouch()
        result = tool(
            make_server(couch), "doc_put",
            {"db": "agent_handoffs", "id": "handoff/2026-09-26-x", "doc": {"title": "hi"}},
        )
        self.assertNotIn("isError", result["result"])
        db, doc_id, doc = couch.puts[0]
        self.assertEqual((db, doc_id), ("agent_handoffs", "handoff/2026-09-26-x"))
        self.assertEqual(doc["agent"], "unknown")
        self.assertIn("expires", doc)

    def test_agent_identity_stamped(self):
        couch = FakeCouch()
        tool(
            make_server(couch), "doc_put",
            {"db": "agent_memory", "id": "dossier/t", "doc": {}, "agent": "opencode", "session": "s9"},
        )
        self.assertEqual(couch.puts[0][2]["agent"], "opencode")
        self.assertEqual(couch.puts[0][2]["session"], "s9")

    def test_vault_db_refused_before_couch(self):
        couch = FakeCouch()
        result = tool(
            make_server(couch), "doc_put",
            {"db": "obsidian", "id": "handoff/2026-09-26-x", "doc": {}},
        )
        self.assertTrue(result["result"].get("isError"))
        self.assertEqual(couch.puts, [])

    def test_bad_id_refused(self):
        couch = FakeCouch()
        result = tool(make_server(couch), "doc_put", {"db": "agent_memory", "id": "dossier/BAD", "doc": {}})
        self.assertTrue(result["result"].get("isError"))
        self.assertEqual(couch.puts, [])


class TestDocGetQueryDelete(unittest.TestCase):
    def seed(self):
        return FakeCouch(
            {
                ("agent_memory", "dossier/one"): {"_id": "dossier/one", "_rev": "r1", "type": "dossier", "title": "One"},
                ("agent_memory", "dossier/two"): {"_id": "dossier/two", "_rev": "r2", "type": "dossier", "title": "Two"},
            }
        )

    def test_get(self):
        result = tool(make_server(self.seed()), "doc_get", {"db": "agent_memory", "id": "dossier/one"})
        self.assertIn("dossier/one", text(result))

    def test_get_missing_is_error(self):
        result = tool(make_server(self.seed()), "doc_get", {"db": "agent_memory", "id": "dossier/nope"})
        self.assertTrue(result["result"].get("isError"))

    def test_query_cap(self):
        server = make_server(self.seed())
        result = tool(server, "doc_query", {"db": "agent_memory", "selector": {"type": "dossier"}, "limit": 9999})
        self.assertIn("dossier/one", text(result))
        self.assertEqual(server.last_query_limit, 200)

    def test_query_refuses_foreign_db(self):
        result = tool(make_server(self.seed()), "doc_query", {"db": "obsidian", "selector": {}})
        self.assertTrue(result["result"].get("isError"))

    def test_delete(self):
        couch = self.seed()
        result = tool(make_server(couch), "doc_delete", {"db": "agent_memory", "id": "dossier/one", "rev": "r1"})
        self.assertNotIn("isError", result["result"])
        self.assertEqual(couch.deletes, [("agent_memory", "dossier/one", "r1")])


class TestTasks(unittest.TestCase):
    def seed(self):
        return FakeCouch(
            {
                ("agent_tasks", "task/q/a"): {"_id": "task/q/a", "_rev": "r1", "type": "task", "queue": "q", "status": "todo"},
                ("agent_tasks", "task/q/b"): {"_id": "task/q/b", "_rev": "r2", "type": "task", "queue": "q", "status": "todo"},
            }
        )

    def test_claim_sets_in_progress(self):
        couch = self.seed()
        result = tool(make_server(couch), "task_claim", {"queue": "q", "agent": "opencode"})
        self.assertIn("task/q/a", text(result))
        self.assertEqual(couch.docs[("agent_tasks", "task/q/a")]["status"], "in_progress")
        self.assertEqual(couch.docs[("agent_tasks", "task/q/a")]["claimed_by"], "opencode")

    def test_claim_skips_taken_and_claims_second(self):
        couch = self.seed()
        couch.docs[("agent_tasks", "task/q/a")]["status"] = "in_progress"
        result = tool(make_server(couch), "task_claim", {"queue": "q"})
        self.assertIn("task/q/b", text(result))

    def test_claim_empty_queue(self):
        result = tool(make_server(FakeCouch()), "task_claim", {"queue": "q"})
        self.assertTrue(result["result"].get("isError"))
        self.assertIn("empty", text(result))

    def test_complete_sets_done_and_expiry(self):
        couch = self.seed()
        result = tool(make_server(couch), "task_complete", {"db": "agent_tasks", "id": "task/q/a"})
        self.assertNotIn("isError", result["result"])
        done_doc = couch.docs[("agent_tasks", "task/q/a")]
        self.assertEqual(done_doc["status"], "done")
        self.assertIn("expires", done_doc)


class TestResolveCredentials(unittest.TestCase):
    def test_env_password_wins(self):
        opts = {"docstore": {"username": "agent"}, "logins": [{"username": "agent", "password": "from-options"}]}
        u, p = resolve_credentials(opts, {"DOCSTORE_PASSWORD": "generated", "DOCSTORE_USERNAME": "agent"})
        self.assertEqual((u, p), ("agent", "generated"))

    def test_options_fallback(self):
        opts = {"docstore": {"username": "agent"}, "logins": [{"username": "agent", "password": "from-options"}]}
        u, p = resolve_credentials(opts, {})
        self.assertEqual((u, p), ("agent", "from-options"))

    def test_blank_everywhere_is_fatal(self):
        opts = {"docstore": {"username": "agent"}, "logins": [{"username": "agent", "password": ""}]}
        with self.assertRaises(SystemExit):
            resolve_credentials(opts, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
