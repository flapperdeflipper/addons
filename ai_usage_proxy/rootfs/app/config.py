"""Home Assistant options, including the original Claude MQTT options."""

import json
import os
from pathlib import Path
from typing import Any


def data_directory() -> Path:
    return Path(
        os.environ.get(
            "AI_USAGE_PROXY_DATA", os.environ.get("CLAUDE_PROXY_DATA", "/data")
        )
    )


def load_options(root: Path) -> dict[str, Any]:
    try:
        raw = json.loads((root / "options.json").read_text())
    except FileNotFoundError:
        raw = {}
    if not isinstance(raw, dict):
        raise TypeError("Options must be an object")

    def string(key: str, default: str = "") -> str:
        value = raw.get(key) or default
        if not isinstance(value, str) or value.startswith("!secret "):
            raise ValueError(f"Option {key} must be a resolved string")
        return value

    def prefix(key: str, default: str) -> str:
        value = string(key, default).strip("/")
        if (
            not value
            or any(char in value for char in ("#", "+", "\x00"))
            or any(c.isspace() for c in value)
        ):
            raise ValueError(f"Invalid MQTT topic prefix: {key}")
        return value

    return {
        "poll_interval": max(10, min(3600, int(raw.get("poll_interval", 60)))),
        "topic_prefix": prefix("topic_prefix", "claude/usage"),
        "ai_topic_prefix": prefix("ai_topic_prefix", "ai/usage"),
        "discovery": raw.get("discovery", True) is True,
        "mqtt_host": string("mqtt_host"),
        "mqtt_port": max(1, min(65535, int(raw.get("mqtt_port") or 1883))),
        "mqtt_username": string("mqtt_username"),
        "mqtt_password": string("mqtt_password"),
    }


def supervisor_token() -> str:
    for name in ("SUPERVISOR_TOKEN", "HASSIO_TOKEN"):
        value = os.environ.get(name, "")
        if value:
            return value
    for name in ("SUPERVISOR_TOKEN", "HASSIO_TOKEN"):
        try:
            value = Path(f"/run/s6/container_environment/{name}").read_text().strip()
            if value:
                return value
        except OSError:
            pass
    return ""
