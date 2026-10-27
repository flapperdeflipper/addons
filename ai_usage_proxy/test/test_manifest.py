"""Release and container contract for the single renamed add-on."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ManifestTests(unittest.TestCase):
    def test_single_renamed_addon_and_release(self):
        self.assertFalse((ROOT.parent / "claude_usage_proxy/config.yaml").exists())
        config = (ROOT / "config.yaml").read_text()
        for entry in (
            "name: AI Usage Proxy",
            "slug: ai_usage_proxy",
            "version: 2.0.1",
            "image: flapperdeflipper/addon-ai-usage-proxy",
            "ingress_port: 8237",
        ):
            self.assertIn(entry, config)

    def test_pinned_codex_and_mqtt_in_container(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn("--checksum=sha256:", dockerfile)
        self.assertIn("codex-0.164.0-linux-x64.tgz", dockerfile)
        self.assertIn("paho-mqtt>=2.1,<3", dockerfile)


if __name__ == "__main__":
    unittest.main()
