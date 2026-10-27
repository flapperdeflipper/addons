"""Provider-neutral values and private credential migration."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))


class ModelStorageTests(unittest.TestCase):
    def test_remaining_becomes_used_and_unknown_is_not_zero(self):
        from models import UsageWindow, percentage_used

        self.assertEqual(percentage_used(78, remaining=True), 22)
        self.assertEqual(percentage_used(78), 78)
        self.assertEqual(percentage_used(0), 0)
        self.assertIsNone(percentage_used(None))
        for invalid in (True, float("nan"), "garbage", -1):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                percentage_used(invalid)
        self.assertIsNone(UsageWindow("short", "Short window", None).used_percent)

    def test_private_storage_migrates_without_overwriting_newer_tokens(self):
        from storage import CredentialStore

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tokens.json").write_text(json.dumps({"refresh_token": "old"}))
            store = CredentialStore(root, "claude")
            store.migrate_claude()
            self.assertEqual(store.read()["refresh_token"], "old")
            self.assertEqual(store.path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(store.path.parent.stat().st_mode & 0o777, 0o700)
            store.write({"refresh_token": "new"})
            store.migrate_claude()
            self.assertEqual(store.read()["refresh_token"], "new")
            store.clear()
            self.assertEqual(store.read(), {})
            store.migrate_claude()
            self.assertEqual(store.read(), {})

    def test_provider_path_rejects_traversal(self):
        from storage import CredentialStore

        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ValueError):
            CredentialStore(Path(tmp), "../other")


if __name__ == "__main__":
    unittest.main()
