#!/usr/bin/env python3
"""Self-running tests for docstore core logic (stdlib only, no network).

Run: python3 test/test_docstore_core.py
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "docstore"))

from core import (  # noqa: E402
    DocstoreError,
    Registry,
    claim_filter,
    prepare_complete,
    prepare_create,
    prepare_update,
    sweep_plan,
    validate_doc_id,
)

NOW = "2026-09-26T12:00:00Z"

REGISTRY = {
    "databases": ["agent_handoffs", "agent_tasks", "agent_memory"],
    "types": {
        "handoff": {
            "db": "agent_handoffs",
            "id_pattern": r"^handoff/\d{4}-\d{2}-\d{2}-[a-z0-9-]+$",
            "ttl_days": 90,
        },
        "task": {
            "db": "agent_tasks",
            "id_pattern": r"^task/[a-z0-9-]+/[a-z0-9-]+$",
            "ttl_days": 30,
            "ttl_from": "done",
        },
        "dossier": {
            "db": "agent_memory",
            "id_pattern": r"^dossier/[a-z0-9-]+$",
        },
    },
}


def reg():
    return Registry.parse(REGISTRY)


class TestRegistryParse(unittest.TestCase):
    def test_valid_registry(self):
        r = reg()
        self.assertEqual(
            r.databases,
            {"agent_handoffs", "agent_tasks", "agent_memory"},
        )
        spec = r.spec("handoff")
        self.assertEqual(spec.db, "agent_handoffs")
        self.assertEqual(spec.ttl_days, 90)
        self.assertEqual(spec.ttl_from, "created")

    def test_ttl_from_defaults_to_created(self):
        self.assertEqual(reg().spec("dossier").ttl_from, "created")

    def test_type_db_must_be_declared(self):
        raw = {"databases": ["a"], "types": {"x": {"db": "b", "id_pattern": "^x/"}}}
        with self.assertRaises(DocstoreError):
            Registry.parse(raw)

    def test_invalid_db_name_rejected(self):
        raw = {"databases": ["BadName"], "types": {}}
        with self.assertRaises(DocstoreError):
            Registry.parse(raw)

    def test_invalid_id_pattern_rejected(self):
        raw = {"databases": ["a"], "types": {"x": {"db": "a", "id_pattern": "("}}}
        with self.assertRaises(DocstoreError):
            Registry.parse(raw)

    def test_bad_ttl_rejected(self):
        raw = {"databases": ["a"], "types": {"x": {"db": "a", "id_pattern": "^x/", "ttl_days": 0}}}
        with self.assertRaises(DocstoreError):
            Registry.parse(raw)

    def test_bad_ttl_from_rejected(self):
        raw = {"databases": ["a"], "types": {"x": {"db": "a", "id_pattern": "^x/", "ttl_from": "whenever"}}}
        with self.assertRaises(DocstoreError):
            Registry.parse(raw)

    def test_empty_databases_rejected(self):
        with self.assertRaises(DocstoreError):
            Registry.parse({"databases": [], "types": {}})


class TestValidateDocId(unittest.TestCase):
    def test_ok(self):
        validate_doc_id(reg(), "agent_handoffs", "handoff/2026-09-26-test", "handoff")

    def test_db_not_allowed(self):
        with self.assertRaises(DocstoreError):
            validate_doc_id(reg(), "obsidian", "handoff/2026-09-26-test", "handoff")

    def test_type_bound_to_other_db(self):
        with self.assertRaises(DocstoreError):
            validate_doc_id(reg(), "agent_tasks", "handoff/2026-09-26-test", "handoff")

    def test_unknown_type(self):
        with self.assertRaises(DocstoreError):
            validate_doc_id(reg(), "agent_handoffs", "note/thing", "note")

    def test_pattern_mismatch(self):
        with self.assertRaises(DocstoreError):
            validate_doc_id(reg(), "agent_handoffs", "handoff/Wrong", "handoff")

    def test_type_in_doc_must_agree(self):
        # doc.type disagreeing with the id namespace is refused by the caller
        # via validate_doc_id(registry, db, doc_id, doc_type); here doc_type
        # is the registry key, so a mismatch means the id does not fit.
        with self.assertRaises(DocstoreError):
            validate_doc_id(reg(), "agent_tasks", "task/q/ok", "handoff")


class TestPrepareCreate(unittest.TestCase):
    def test_stamps_audit_fields_and_ttl(self):
        doc = prepare_create(
            reg(), "agent_handoffs", "handoff/2026-09-26-test",
            {"title": "t", "tags": ["a"], "body": "x"},
            now=NOW, agent="opencode", session="s1",
        )
        self.assertEqual(doc["created"], NOW)
        self.assertEqual(doc["updated"], NOW)
        self.assertEqual(doc["agent"], "opencode")
        self.assertEqual(doc["session"], "s1")
        self.assertEqual(doc["type"], "handoff")
        # 90 days after creation
        self.assertEqual(doc["expires"], "2026-12-25T12:00:00Z")

    def test_explicit_null_opts_out(self):
        doc = prepare_create(
            reg(), "agent_handoffs", "handoff/2026-09-26-test",
            {"expires": None}, now=NOW, agent="a", session="s",
        )
        self.assertNotIn("expires", doc)

    def test_explicit_expiry_preserved_and_normalized(self):
        doc = prepare_create(
            reg(), "agent_handoffs", "handoff/2026-09-26-test",
            {"expires": "2026-10-01T00:00:00+02:00"}, now=NOW, agent="a", session="s",
        )
        self.assertEqual(doc["expires"], "2026-09-30T22:00:00Z")

    def test_invalid_expiry_rejected(self):
        with self.assertRaises(DocstoreError):
            prepare_create(
                reg(), "agent_handoffs", "handoff/2026-09-26-test",
                {"expires": "next tuesday"}, now=NOW, agent="a", session="s",
            )

    def test_ttl_from_done_no_expiry_at_create(self):
        doc = prepare_create(
            reg(), "agent_tasks", "task/q/job-1",
            {"queue": "q", "status": "todo"}, now=NOW, agent="a", session="s",
        )
        self.assertNotIn("expires", doc)

    def test_no_ttl_no_expiry(self):
        doc = prepare_create(
            reg(), "agent_memory", "dossier/topic",
            {}, now=NOW, agent="a", session="s",
        )
        self.assertNotIn("expires", doc)


class TestPrepareUpdate(unittest.TestCase):
    def test_preserves_created_carries_expiry(self):
        existing = {
            "created": "2026-01-01T00:00:00Z",
            "expires": "2027-01-01T00:00:00Z",
        }
        doc = prepare_update(
            reg(), "agent_memory", "dossier/topic",
            {"title": "new"}, existing, now=NOW, agent="b", session="s2",
        )
        self.assertEqual(doc["created"], "2026-01-01T00:00:00Z")
        self.assertEqual(doc["updated"], NOW)
        self.assertEqual(doc["agent"], "b")
        self.assertEqual(doc["expires"], "2027-01-01T00:00:00Z")

    def test_null_drops_expiry(self):
        doc = prepare_update(
            reg(), "agent_memory", "dossier/topic",
            {"expires": None}, {"created": "2026-01-01T00:00:00Z", "expires": "2027-01-01T00:00:00Z"},
            now=NOW, agent="b", session="s2",
        )
        self.assertNotIn("expires", doc)

    def test_cannot_change_type(self):
        with self.assertRaises(DocstoreError):
            prepare_update(
                reg(), "agent_memory", "dossier/topic",
                {"type": "handoff"}, {"created": "2026-01-01T00:00:00Z"},
                now=NOW, agent="b", session="s2",
            )


class TestPrepareComplete(unittest.TestCase):
    def test_sets_done_and_expiry(self):
        doc = prepare_complete(
            reg(), "agent_tasks", "task/q/job-1",
            {"type": "task", "queue": "q", "status": "in_progress", "created": "2026-09-01T00:00:00Z"},
            now=NOW,
        )
        self.assertEqual(doc["status"], "done")
        self.assertEqual(doc["done"], NOW)
        self.assertEqual(doc["expires"], "2026-10-26T12:00:00Z")

    def test_only_task_type(self):
        with self.assertRaises(DocstoreError):
            prepare_complete(
                reg(), "agent_memory", "dossier/topic",
                {"type": "dossier"}, now=NOW,
            )

    def test_missing_task_type_in_registry(self):
        raw = {"databases": ["a"], "types": {"x": {"db": "a", "id_pattern": "^x/"}}}
        with self.assertRaises(DocstoreError):
            prepare_complete(Registry.parse(raw), "a", "x/1", {"type": "x"}, now=NOW)


class TestSweepAndClaim(unittest.TestCase):
    def test_sweep_plan_covers_all_dbs(self):
        plan = sweep_plan(reg(), NOW)
        self.assertEqual({db for db, _ in plan}, {"agent_handoffs", "agent_tasks", "agent_memory"})
        for _, selector in plan:
            self.assertEqual(
                selector["selector"],
                {"expires": {"$lte": NOW}},
            )
            self.assertGreater(selector["limit"], 0)

    def test_claim_filter_shape(self):
        f = claim_filter("maintenance")
        self.assertEqual(
            f["selector"],
            {"type": "task", "queue": "maintenance", "status": "todo"},
        )


class TestTimestampHelpers(unittest.TestCase):
    def test_utc_now_iso_format(self):
        from core import utc_now_iso

        v = utc_now_iso()
        self.assertRegex(v, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        datetime.strptime(v, "%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    unittest.main(verbosity=2)
