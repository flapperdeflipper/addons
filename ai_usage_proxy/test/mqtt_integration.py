"""Optional real-broker check: MQTT_TEST_PORT=1883 python test/mqtt_integration.py."""

import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "rootfs/app"))
import paho.mqtt.client as mqtt
from config import load_options
from mqtt_publisher import MqttPublisher
from service import UsageService
from test_service import FakeProvider


def wait_for(predicate, message):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError(message)


def main():
    port = int(os.environ["MQTT_TEST_PORT"])
    messages = {}
    lock = threading.Lock()
    probe = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)

    def connected(client, userdata, flags, reason, properties):
        client.subscribe("#", qos=1)

    def received(client, userdata, message):
        with lock:
            messages[message.topic] = message.payload.decode()

    probe.on_connect, probe.on_message = connected, received
    probe.connect("127.0.0.1", port)
    probe.loop_start()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            provider = FakeProvider(root, "claude")
            provider.has_token = True
            service = UsageService({"claude": provider})
            options = load_options(root)
            options.update(mqtt_host="127.0.0.1", mqtt_port=port)
            publisher = MqttPublisher(options, root, service.action)
            service.listeners.append(
                lambda key: publisher.publish_provider(service.view(key))
            )
            worker = threading.Thread(target=publisher.run, daemon=True)
            worker.start()
            service.start()
            try:
                wait_for(
                    lambda: messages.get("ai/usage/claude/session_percent") == "22",
                    "Session used value missing",
                )
                wait_for(
                    lambda: (
                        messages.get("ai/usage/claude/windows/short/used_percent")
                        == "22"
                    ),
                    "Canonical used value missing",
                )
                state = json.loads(messages["ai/usage/claude/state"])
                assert state["windows"]["short"]["used_percent"] == 22
                config = json.loads(
                    messages[
                        "homeassistant/sensor/ai_usage_proxy/"
                        "claude_short_used_percent/config"
                    ]
                )
                assert (
                    config["unique_id"]
                    == "ai_usage_proxy_claude_short_used_percent"
                )
                assert config["availability"][0]["topic"] == "ai/usage/status"
                reads = provider.reads
                probe.publish(
                    "ai/usage/claude/command/refresh", "1", qos=1, retain=False
                ).wait_for_publish()
                wait_for(
                    lambda: provider.reads > reads,
                    "MQTT refresh did not reach provider",
                )
                service.action("claude", "disconnect")
                wait_for(
                    lambda: messages.get("ai/usage/claude/session_percent") == "",
                    "Disconnected metric was not cleared",
                )
                wait_for(
                    lambda: messages.get("ai/usage/claude/availability") == "offline",
                    "Provider did not become unavailable",
                )
            finally:
                service.close()
                publisher.close()
                worker.join(timeout=2)
            wait_for(
                lambda: messages.get("ai/usage/status") == "proxy offline",
                "Process offline state missing",
            )
            print(
                "Real MQTT check passed: used percentages, discovery identities, refresh routing, retained cleanup, shutdown availability."
            )
    finally:
        probe.disconnect()
        probe.loop_stop()


if __name__ == "__main__":
    main()
