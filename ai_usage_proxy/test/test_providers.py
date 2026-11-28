"""Provider registry: what ships, and what a retired provider leaves behind."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))
from providers import create_providers
from storage import private_directory


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_ships_claude_and_zai_only(self):
        self.assertEqual(sorted(create_providers(self.root)), ["claude", "zai"])

    def test_retired_provider_credentials_are_deleted_at_start(self):
        # 2.1.x kept the OpenAI account in the provider's private directory.
        codex = private_directory(self.root / "providers" / "openai" / "codex")
        (codex / "auth.json").write_text("{}")
        (codex.parent / "credentials.json").write_text("{}")
        zai = private_directory(self.root / "providers" / "zai")
        (zai / "credentials.json").write_text("{}")

        create_providers(self.root)

        self.assertFalse((self.root / "providers" / "openai").exists())
        self.assertTrue((zai / "credentials.json").exists())


if __name__ == "__main__":
    unittest.main()
