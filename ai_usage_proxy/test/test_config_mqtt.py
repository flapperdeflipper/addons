"""Options compatibility and display/HA MQTT contracts."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))
from models import UsageSnapshot, UsageWindow


class FakeClient:
    def __init__(self):
        self.messages = {}
        self.subscriptions = []

    def publish(self, topic, payload, qos=0, retain=False):
        self.messages[topic] = str(payload)

    def subscribe(self, topic, qos=0):
        self.subscriptions.append(topic)


def view(used=22, reset=1800000000):
    return {
        "id": "claude",
        "name": "Claude",
        "status": "ok",
        "message": "Connected",
        "connection": "connected",
        "available": True,
        "stale": False,
        "snapshot": UsageSnapshot(
            "claude",
            1700000000,
            (
                UsageWindow("five_hour", "5-hour", used, 18000, reset, role="session"),
                UsageWindow("seven_day", "Weekly", 35, 604800, role="week"),
            ),
        ).public(),
    }


class ConfigMqttTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_options_defaults_and_secret_rejection(self):
        from config import load_options

        opts = load_options(self.root)
        self.assertEqual(opts["ai_topic_prefix"], "ai/usage")
        (self.root / "options.json").write_text(
            json.dumps({"mqtt_password": "!secret missing"})
        )
        with self.assertRaises(ValueError):
            load_options(self.root)

    def test_used_metrics_ai_identities_and_missing_value_cleanup(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        client = FakeClient()
        publisher = MqttPublisher(
            load_options(self.root), self.root, lambda *_: None, client=client
        )
        publisher.connected = True
        publisher.publish_provider(view())
        self.assertEqual(client.messages["ai/usage/claude/session_percent"], "22")
        self.assertEqual(
            client.messages["ai/usage/claude/windows/five_hour/used_percent"], "22"
        )
        payload = json.loads(
            client.messages[
                "homeassistant/sensor/ai_usage_proxy/"
                "claude_five_hour_used_percent/config"
            ]
        )
        self.assertEqual(
            payload["unique_id"], "ai_usage_proxy_claude_five_hour_used_percent"
        )
        self.assertEqual(payload["state_topic"], "ai/usage/claude/state")
        self.assertIn("five_hour", payload["value_template"])
        self.assertEqual(payload["availability"][0]["topic"], "ai/usage/status")
        publisher.publish_provider(view(used=None, reset=None))
        self.assertEqual(client.messages["ai/usage/claude/session_percent"], "")
        self.assertEqual(
            client.messages["ai/usage/claude/windows/five_hour/used_percent"], ""
        )
        self.assertEqual(
            client.messages["ai/usage/claude/windows/five_hour/resets_at"], ""
        )

    def test_disconnect_clears_retained_values_across_publisher_restart(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        client = FakeClient()
        opts = load_options(self.root)
        publisher = MqttPublisher(opts, self.root, lambda *_: None, client=client)
        publisher.connected = True
        publisher.publish_provider(view())
        publisher = MqttPublisher(opts, self.root, lambda *_: None, client=client)
        publisher.connected = True
        state = view()
        state.update(
            snapshot=None,
            available=False,
            connection="disconnected",
            status="disconnected",
        )
        publisher.publish_provider(state)
        self.assertEqual(
            client.messages["ai/usage/claude/windows/five_hour/used_percent"], ""
        )
        self.assertEqual(client.messages["ai/usage/claude/session_percent"], "")

    def test_unknown_reset_is_unavailable_in_discovery(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        client = FakeClient()
        pub = MqttPublisher(
            load_options(self.root), self.root, lambda *_: None, client=client
        )
        pub.connected = True
        pub.publish_provider(view(reset=None))
        cfg = json.loads(
            client.messages[
                "homeassistant/sensor/ai_usage_proxy/"
                "claude_five_hour_resets_at/config"
            ]
        )
        availability = json.dumps(cfg["availability"])
        self.assertIn("resets_at", availability)
        self.assertIn("is not none", availability)

    def test_unknown_reset_renders_none_instead_of_template_error(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        client = FakeClient()
        pub = MqttPublisher(
            load_options(self.root), self.root, lambda *_: None, client=client
        )
        pub.connected = True
        zai = {
            "id": "zai",
            "name": "z.ai",
            "status": "ok",
            "message": "Connected",
            "connection": "connected",
            "available": True,
            "stale": False,
            "snapshot": UsageSnapshot(
                "zai",
                1700000000,
                (
                    UsageWindow("mcp", "Monthly MCP", 0, None, role="other"),
                    UsageWindow("tokens", "5-hour", 2, 18000, role="session"),
                ),
            ).public(),
        }
        pub.publish_provider(zai)
        pub.publish_provider(view(reset=None))
        cfg = json.loads(
            client.messages[
                "homeassistant/sensor/ai_usage_proxy/zai_tokens_resets_at/config"
            ]
        )
        self.assertEqual(
            cfg["value_template"],
            '{{ (value_json.windows["tokens"].resets_at | int) | timestamp_utc '
            'if value_json.windows["tokens"].resets_at is not none else \'None\' }}',
        )
        claude = json.loads(
            client.messages[
                "homeassistant/sensor/ai_usage_proxy/"
                "claude_five_hour_resets_at/config"
            ]
        )
        self.assertIn("is not none else 'None'", claude["value_template"])
        used = json.loads(
            client.messages[
                "homeassistant/sensor/ai_usage_proxy/zai_tokens_used_percent/config"
            ]
        )
        self.assertEqual(
            used["value_template"], '{{ value_json.windows["tokens"].used_percent }}'
        )

    def test_new_provider_commands_need_no_publisher_changes(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        calls = []
        pub = MqttPublisher(
            load_options(self.root),
            self.root,
            lambda key, action: calls.append((key, action)),
        )

        class Message:
            topic = "ai/usage/fourth_provider/command/refresh"
            retain = False

        pub.on_message(None, None, Message())
        self.assertEqual(calls, [("fourth_provider", "refresh")])

    def test_failed_retained_cleanup_is_retried_after_restart(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        class RejectOneClear(FakeClient):
            reject = True

            def publish(self, topic, payload, qos=0, retain=False):
                if (
                    self.reject
                    and topic.endswith("/seven_day/used_percent")
                    and payload == ""
                ):
                    self.reject = False
                    return type("FailedPublish", (), {"rc": 4})()
                return super().publish(topic, payload, qos, retain)

        client = RejectOneClear()
        options = load_options(self.root)
        publisher = MqttPublisher(options, self.root, lambda *_: None, client=client)
        publisher.connected = True
        publisher.publish_provider(view())
        state = view()
        state["snapshot"]["windows"] = state["snapshot"]["windows"][:1]
        publisher.publish_provider(state)
        publisher = MqttPublisher(options, self.root, lambda *_: None, client=client)
        publisher.connected = True
        publisher.publish_provider(state)
        self.assertEqual(
            client.messages["ai/usage/claude/windows/seven_day/used_percent"], ""
        )

    def test_retained_or_nonexact_commands_do_not_trigger_http_work(self):
        from config import load_options
        from mqtt_publisher import MqttPublisher

        calls = []
        pub = MqttPublisher(
            load_options(self.root),
            self.root,
            lambda key, action: calls.append((key, action)),
        )

        class Message:
            topic = "ai/usage/openai/command/refresh"
            retain = True

        pub.on_message(None, None, Message())
        self.assertFalse(calls)
        Message.retain = False
        pub.on_message(None, None, Message())
        self.assertEqual(calls, [("openai", "refresh")])
        Message.topic = "other/command/refresh"
        pub.on_message(None, None, Message())
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
