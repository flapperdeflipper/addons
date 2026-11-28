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
            "image: flapperdeflipper/addon-ai-usage-proxy",
            "ingress_port: 8237",
        ):
            self.assertIn(entry, config)
        # Plain semver, not a fixed value: every release changes it. Quoted or
        # bare: scripts/renovate-post-upgrade.sh writes version: "X.Y.Z".
        self.assertRegex(config, r'(?m)^version:\s*"?\d+\.\d+\.\d+"?\s*$')
        # Claude and z.ai only: the OpenAI / Codex provider was removed.
        self.assertNotIn("OpenAI", config)

    def test_image_pins_mqtt_and_ships_no_codex(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn("paho-mqtt>=2.1,<3", dockerfile)
        # The bundled Codex account service was the only reason this add-on
        # resolved chatgpt.com.
        self.assertNotIn("codex", dockerfile.lower())


if __name__ == "__main__":
    unittest.main()
