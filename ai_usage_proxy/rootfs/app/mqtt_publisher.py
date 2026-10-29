"""Provider-neutral retained metrics and HA discovery."""

import hashlib
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

import paho.mqtt.client as mqtt
from config import supervisor_token
from providers.base import ProviderError

LOG = logging.getLogger(__name__)


def topic_id(value: str) -> str:
    """Keep readable IDs without collapsing distinct upstream IDs into one topic."""
    if re.fullmatch(r"[a-zA-Z0-9_-]+", value):
        return value
    return (
        re.sub(r"[^a-zA-Z0-9_-]", "_", value)[:64]
        + "_"
        + hashlib.sha256(value.encode()).hexdigest()[:10]
    )


class MqttPublisher:
    def __init__(
        self,
        options: dict[str, Any],
        root: Path,
        action: Callable[..., Any],
        *,
        client: Any = None,
    ) -> None:
        self.options = options
        self.root = root
        self.action = action
        self.client = client
        self.connected = False
        self.source = "not connected"
        self.addon_slug = ""
        self.stop = threading.Event()
        self.lock = threading.RLock()
        self.cache: dict[str, str] = {}
        self.clears: dict[str, Any] = {}
        self.views: dict[str, dict[str, Any]] = {}
        self.manifest_file = root / "mqtt_manifest.json"
        try:
            self.inventory = json.loads(self.manifest_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self.inventory = {}

    def public(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "source": self.source,
            "topic_root": self.options["ai_topic_prefix"],
            "discovery": self.options["discovery"],
            "poll_interval": self.options["poll_interval"],
            "addon_slug": self.addon_slug,
        }

    def _send(self, topic: str, payload: Any) -> bool:
        text = "" if payload is None else str(payload)
        if self.client is None or not self.connected:
            return False
        if self.cache.get(topic) != text:
            result = self.client.publish(topic, text, qos=1, retain=True)
            if result is not None and getattr(result, "rc", 0) != 0:
                return False
            self.cache[topic] = text
            if not text and result is not None and hasattr(result, "is_published"):
                self.clears[topic] = result
        if not text and topic in self.clears:
            if not self.clears[topic].is_published():
                return False
            del self.clears[topic]
        return True

    def _store_inventory(self) -> None:
        tmp = self.manifest_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.inventory))
        os.replace(tmp, self.manifest_file)

    def _process_availability(self) -> dict[str, str]:
        # One connection has one LWT: the process will lives on the shared root.
        return {
            "topic": f"{self.options['ai_topic_prefix']}/status",
            "value_template": "{{ 'offline' if value == 'proxy offline' else 'online' }}",
        }

    def _discovery(
        self, key: str, name: str, root: str, window_id: str, label: str, metric: str
    ) -> tuple[str, dict[str, Any]]:
        slug = f"{key}_{topic_id(window_id)}_{metric}"
        field = json.dumps(window_id)
        cfg: dict[str, Any] = {
            "name": f"{name} {label} {'Usage' if metric == 'used_percent' else 'Reset'}",
            "unique_id": f"ai_usage_proxy_{slug}",
            "state_topic": f"{root}/state",
            "device": {
                "identifiers": ["ai_usage_proxy"],
                "name": "AI Usage Proxy",
                "manufacturer": "flapperdeflipper",
            },
            "availability_mode": "all",
            "availability": [
                self._process_availability(),
                {
                    "topic": f"{root}/state",
                    "value_template": "{{ 'online' if value_json.available and "
                    f'value_json.windows.get({field}, {{}}).get("{metric}") is not none '
                    "else 'offline' }}",
                },
            ],
            "expire_after": max(self.options["poll_interval"] * 3, 900),
        }
        expression = f"value_json.windows[{field}].{metric}"
        if metric == "used_percent":
            cfg.update(
                unit_of_measurement="%",
                state_class="measurement",
                icon="mdi:progress-clock",
                value_template="{{ " + expression + " }}",
            )
        else:
            # HA renders value_template for every state payload even while
            # availability reports offline, and int(None) raises without a
            # default. Yield the string None so an unknown reset reads as
            # unknown instead of logging a template error on every publish.
            cfg.update(
                device_class="timestamp",
                value_template="{{ (" + expression + " | int) | timestamp_utc if "
                + expression + " is not none else 'None' }}",
            )
        return f"homeassistant/sensor/ai_usage_proxy/{slug}/config", cfg

    def publish_provider(self, view: dict[str, Any]) -> None:
        key = view["id"]
        with self.lock:
            self.views[key] = view
            if not self.connected:
                return
            root = f"{self.options['ai_topic_prefix']}/{key}"
            snapshot = view["snapshot"]
            windows = {w["id"]: w for w in snapshot["windows"]} if snapshot else {}
            state = {
                "schema_version": 1,
                "status": view["status"],
                "message": view["message"],
                "connection": view["connection"],
                "available": view["available"],
                "last_update": view.get("confirmed_at"),
                "windows": windows,
                "aliases": {},
            }
            topics: dict[str, Any] = {
                f"{root}/state": json.dumps(state, allow_nan=False),
                f"{root}/status": view["status"],
                f"{root}/availability": "online" if view["available"] else "offline",
                f"{root}/last_update": state["last_update"],
            }
            configs: dict[str, dict[str, Any]] = {}
            for window_id, window in windows.items():
                base = f"{root}/windows/{topic_id(window_id)}"
                for metric in ("used_percent", "resets_at", "duration_seconds"):
                    topics[f"{base}/{metric}"] = window[metric]
                if self.options["discovery"]:
                    for metric in ("used_percent", "resets_at"):
                        topic, cfg = self._discovery(
                            key,
                            view["name"],
                            root,
                            window_id,
                            window["label"],
                            metric,
                        )
                        configs[topic] = cfg
            for role in ("session", "week"):
                candidates = [w for w in windows.values() if w["role"] == role]
                window = candidates[0] if len(candidates) == 1 else None
                topics[f"{root}/{role}_percent"] = (
                    window["used_percent"] if window else None
                )
                topics[f"{root}/{role}_resets_at"] = (
                    window["resets_at"] if window else None
                )
                for metric in (f"{role}_percent", f"{role}_resets_at"):
                    state["aliases"][metric] = topics[f"{root}/{metric}"]
            topics[f"{root}/state"] = json.dumps(state, allow_nan=False)
            if self.options["discovery"]:
                self._provider_diagnostics(key, view, root, configs)
            previous = self.inventory.get(key, [])
            current = sorted([*topics, *configs])
            pending = [
                topic
                for topic in set(previous) - set(current)
                if not self._send(topic, None)
            ]
            for topic, payload in topics.items():
                self._send(topic, payload)
            for topic, config in configs.items():
                self._send(topic, json.dumps(config))
            inventory = sorted(current + pending)
            if previous != inventory:
                self.inventory[key] = inventory
                self._store_inventory()

    def _provider_diagnostics(
        self, key: str, view: dict[str, Any], root: str, configs: dict[str, dict[str, Any]]
    ) -> None:
        """Status, last-update and online/offline sensors per provider."""
        device = {
            "identifiers": ["ai_usage_proxy"],
            "name": "AI Usage Proxy",
            "manufacturer": "flapperdeflipper",
        }
        configs[f"homeassistant/sensor/ai_usage_proxy/{key}_status/config"] = {
            "name": f'{view["name"]} Status',
            "unique_id": f"ai_usage_proxy_{key}_status",
            "state_topic": f"{root}/status",
            "device": device,
            "availability_mode": "all",
            "availability": [self._process_availability()],
            "entity_category": "diagnostic",
            "icon": "mdi:connection",
        }
        configs[f"homeassistant/sensor/ai_usage_proxy/{key}_last_update/config"] = {
            "name": f'{view["name"]} Last Update',
            "unique_id": f"ai_usage_proxy_{key}_last_update",
            "state_topic": f"{root}/last_update",
            # Empty payload (no snapshot yet) must not reach int - same
            # null-safety rule as the window reset templates.
            "value_template": "{{ (value | int) | timestamp_utc if value else 'None' }}",
            "device": device,
            "availability_mode": "all",
            "availability": [self._process_availability()],
            "entity_category": "diagnostic",
            "device_class": "timestamp",
        }
        configs[
            f"homeassistant/binary_sensor/ai_usage_proxy/{key}_availability/config"
        ] = {
            "name": f'{view["name"]} Online',
            "unique_id": f"ai_usage_proxy_{key}_availability",
            "state_topic": f"{root}/availability",
            "payload_on": "online",
            "payload_off": "offline",
            "device_class": "connectivity",
            "device": device,
            "availability_mode": "all",
            "availability": [self._process_availability()],
            "entity_category": "diagnostic",
        }

    def on_message(self, client: Any, userdata: Any, message: Any) -> None:
        if message.retain:
            return
        match = re.fullmatch(
            re.escape(self.options["ai_topic_prefix"])
            + r"/([a-z][a-z0-9_]*)/command/refresh",
            message.topic,
        )
        key = match[1] if match else None
        if key:
            try:
                self.action(key, "refresh")
            except ProviderError:
                pass

    def _on_connect(
        self, client: Any, userdata: Any, flags: Any, reason: Any, properties: Any
    ) -> None:
        if reason != 0:
            return
        with self.lock:
            self.connected = True
            self.cache.clear()
            client.subscribe(
                f"{self.options['ai_topic_prefix']}/+/command/refresh", qos=1
            )
            self._send(f"{self.options['ai_topic_prefix']}/status", "starting")
            if self.options["discovery"]:
                self._send(
                    "homeassistant/sensor/ai_usage_proxy/status/config",
                    json.dumps(
                        {
                            # Device-name prefixing completes this to
                            # "AI Usage Proxy Status" in Home Assistant.
                            "name": "Status",
                            "unique_id": "ai_usage_proxy_status",
                            "state_topic": f"{self.options['ai_topic_prefix']}/status",
                            "device": {
                                "identifiers": ["ai_usage_proxy"],
                                "name": "AI Usage Proxy",
                                "manufacturer": "flapperdeflipper",
                            },
                            "availability_mode": "all",
                            "availability": [self._process_availability()],
                            "entity_category": "diagnostic",
                            "icon": "mdi:progress-clock",
                        }
                    ),
                )
            for view in list(self.views.values()):
                self.publish_provider(view)
            # "starting" cleared the crash will; bootstrap is done.
            self._send(f"{self.options['ai_topic_prefix']}/status", "ok")

    def _on_disconnect(self, *args: Any) -> None:
        self.connected = False

    def _credentials(self) -> tuple[str, int, str, str] | None:
        token = supervisor_token()
        if token:
            if not self.addon_slug:
                info = urllib.request.Request(
                    "http://supervisor/addons/self/info",
                    headers={"Authorization": f"Bearer {token}"},
                )
                try:
                    with urllib.request.urlopen(info, timeout=10) as response:
                        slug = json.load(response)["data"]["slug"]
                    if isinstance(slug, str):
                        self.addon_slug = slug
                except (OSError, KeyError, ValueError):
                    pass
            request = urllib.request.Request(
                "http://supervisor/services/mqtt",
                headers={"Authorization": f"Bearer {token}"},
            )
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    data = json.load(response)["data"]
                self.source = "Home Assistant MQTT service"
                return (
                    data["host"],
                    int(data["port"]),
                    data.get("username", ""),
                    data.get("password", ""),
                )
            except (OSError, KeyError, ValueError):
                LOG.warning(
                    "Supervisor MQTT service unavailable; checking manual fallback"
                )
        if self.options["mqtt_host"]:
            self.source = "Manual broker configuration"
            return (
                self.options["mqtt_host"],
                self.options["mqtt_port"],
                self.options["mqtt_username"],
                self.options["mqtt_password"],
            )
        self.source = "MQTT service unavailable; no manual broker configured"
        return None

    def run(self) -> None:
        while not self.stop.is_set():
            if self.client is None:
                credentials = self._credentials()
                if credentials:
                    host, port, user, password = credentials
                    client = mqtt.Client(
                        mqtt.CallbackAPIVersion.VERSION2, client_id="ai_usage_proxy"
                    )
                    if user:
                        client.username_pw_set(user, password)
                    client.will_set(
                        f"{self.options['ai_topic_prefix']}/status",
                        "proxy offline",
                        qos=1,
                        retain=True,
                    )
                    client.on_connect = self._on_connect
                    client.on_disconnect = self._on_disconnect
                    client.on_message = self.on_message
                    client.reconnect_delay_set(min_delay=2, max_delay=60)
                    client.connect_async(host, port, keepalive=60)
                    self.client = client
                    client.loop_start()
            self.stop.wait(10)

    def close(self) -> None:
        self.stop.set()
        with self.lock:
            for key in self.views:
                self._send(
                    f"{self.options['ai_topic_prefix']}/{key}/availability", "offline"
                )
            self._send(
                f"{self.options['ai_topic_prefix']}/status", "proxy offline"
            )
        if self.client is not None:
            self.client.disconnect()
            self.client.loop_stop()
        self.connected = False
