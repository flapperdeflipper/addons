#!/usr/bin/env python3
"""Claude usage proxy: one OAuth token lineage, browser renewal, MQTT metrics.

Replaces the per-device OAuth flow of the ESPHome claude_usage component:
this add-on is the only thing that talks to Anthropic. The displays subscribe
to MQTT topics; the single web page (Ingress) shows status and handles the
authorization-code + PKCE renewal flow. Nothing else is exposed.
"""
from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import os
import secrets
import signal
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import paho.mqtt.client as mqtt

LOG = logging.getLogger("claude_usage_proxy")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# Claude Code's public OAuth client (hard-coded in the CLI, not a secret).
# Same constants as esphome/scripts/mint-device-token.py.
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
TOKEN_URLS = [
    "https://platform.claude.com/v1/oauth/token",
    "https://console.anthropic.com/v1/oauth/token",
]
REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
SCOPE = "org:create_api_key user:profile user:inference"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
BETA_HEADER = "oauth-2025-04-20"

DATA_DIR = os.environ.get("CLAUDE_PROXY_DATA", "/data")
TOKENS_FILE = os.path.join(DATA_DIR, "tokens.json")
OPTIONS_FILE = os.path.join(DATA_DIR, "options.json")
HTTP_PORT = 8237  # matches ingress_port in config.yaml

REFRESH_MARGIN = 300  # refresh the access token this many seconds before expiry
RATE_LIMIT_BACKOFF = 300  # 429: wait this long before polling again
DEAD_TOKEN_RETRY = 600  # token rejected: recheck this often until renewed
PKCE_MAX_AGE = 900  # a pending authorize link stays valid this long


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _as_int(value, default: int, lo: int | None = None, hi: int | None = None) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def load_options() -> dict:
    raw: dict = {}
    try:
        with open(OPTIONS_FILE) as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    def s(key: str) -> str:
        v = raw.get(key)
        return "" if not v or v == "null" else str(v)

    return {
        "poll_interval": _as_int(raw.get("poll_interval"), 60, 10, 3600),
        "topic_prefix": s("topic_prefix") or "claude/usage",
        "discovery": raw.get("discovery", True) is True,
        "mqtt_host": s("mqtt_host"),
        "mqtt_port": _as_int(raw.get("mqtt_port"), 1883, 1, 65535),
        "mqtt_username": s("mqtt_username"),
        "mqtt_password": s("mqtt_password"),
    }


def iso_to_epoch(value: str | None) -> int:
    if not value:
        return 0
    try:
        return int(datetime.fromisoformat(value).timestamp())
    except ValueError:
        return 0


class ClaudeUsageProxy:
    """Owns tokens, the poll loop and the MQTT client. One instance per process."""

    def __init__(self) -> None:
        self.opts = load_options()
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.stop = threading.Event()

        self.refresh_token = ""
        self.access_token = ""
        self.expires_at = 0.0
        self.token_dead = False
        self.dead_retry_at = 0.0
        self.backoff_until = 0.0

        self.status = "starting"
        self.session_pct: float | None = None
        self.week_pct: float | None = None
        self.session_reset_epoch = 0
        self.week_reset_epoch = 0
        self.last_ok = 0.0

        self.pkce: tuple[str, float] | None = None  # (verifier, created); state == verifier
        self.client: mqtt.Client | None = None
        self.mqtt_connected = False

        self._load_tokens()

    # --- tokens -------------------------------------------------------------

    def _load_tokens(self) -> None:
        try:
            with open(TOKENS_FILE) as f:
                data = json.load(f)
            self.refresh_token = data.get("refresh_token", "")
            self.access_token = data.get("access_token", "")
            self.expires_at = float(data.get("expires_at", 0))
            LOG.info("loaded tokens from disk (refresh token present: %s)", bool(self.refresh_token))
        except FileNotFoundError:
            LOG.info("no stored tokens yet; renew via the web UI")
        except (OSError, json.JSONDecodeError, ValueError) as e:
            LOG.warning("could not read %s: %s", TOKENS_FILE, e)

    def _save_tokens(self) -> None:
        tmp = TOKENS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(
                {
                    "refresh_token": self.refresh_token,
                    "access_token": self.access_token,
                    "expires_at": self.expires_at,
                },
                f,
            )
        os.chmod(tmp, 0o600)
        os.replace(tmp, TOKENS_FILE)

    # --- generic HTTP -------------------------------------------------------

    def _http_json(self, url: str, method: str, body=None, headers=None, timeout=30):
        data = json.dumps(body).encode() if body is not None else None
        h = {"User-Agent": "claude-cli/1.0"}
        if headers:
            h.update(headers)
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = resp.read().decode() or "{}"
                return resp.status, json.loads(payload)
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode(errors="replace") or "{}")
            except json.JSONDecodeError:
                payload = {}
            return e.code, payload
        except Exception as e:  # noqa: BLE001 - transport failure, report as status 0
            LOG.warning("%s %s failed: %s", method, url, e)
            return 0, {}

    # --- OAuth --------------------------------------------------------------

    def refresh_access(self) -> bool:
        """POST /v1/oauth/token with the refresh token; rotate + persist."""
        if not self.refresh_token:
            self._set_status("no token - renew via web UI")
            return False
        LOG.info("refreshing access token (token len=%d)", len(self.refresh_token))
        status, data = 0, {}
        for url in TOKEN_URLS:
            status, data = self._http_json(
                url,
                "POST",
                body={
                    "grant_type": "refresh_token",
                    "refresh_token": self.refresh_token,
                    "client_id": CLIENT_ID,
                },
                headers={"Content-Type": "application/json"},
            )
            if status != 0:
                break  # the server answered; trying the fallback won't change it
        if status != 200:
            self.token_dead = True
            self.dead_retry_at = time.time() + DEAD_TOKEN_RETRY
            # OAuth error bodies carry no token, safe to log.
            LOG.warning("token refresh rejected: http %s %s", status, json.dumps(data)[:200])
            self._set_status(f"token rejected (http {status}) - renew via web UI")
            return False
        self.access_token = data.get("access_token", "")
        self.refresh_token = data.get("refresh_token", self.refresh_token)
        self.expires_at = time.time() + int(data.get("expires_in", 28800))
        self.token_dead = False
        self._save_tokens()
        LOG.info("token refreshed, expires in %ds", int(self.expires_at - time.time()))
        return True

    def begin_authorize(self) -> str:
        """Build the authorization URL; one pending PKCE pair at a time."""
        now = time.time()
        if self.pkce is None or now - self.pkce[1] > PKCE_MAX_AGE:
            self.pkce = (b64url(secrets.token_bytes(32)), now)
        verifier, _ = self.pkce
        challenge = b64url(hashlib.sha256(verifier.encode()).digest())
        # The Claude CLI sends the PKCE verifier as the OAuth state and the
        # token endpoint enforces that binding - a separate random state is
        # rejected with "Invalid request format". Match the CLI exactly
        # (same as esphome/scripts/mint-device-token.py).
        state = verifier
        params = {
            "code": "true",
            "client_id": CLIENT_ID,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": state,
        }
        return AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)

    def complete_authorize(self, pasted: str) -> tuple[bool, str]:
        """Exchange a pasted `code#state` for tokens and take over the lineage."""
        raw = pasted.strip()
        code, _, state = raw.partition("#")
        if not code:
            return False, "Nothing pasted - copy the code from the callback page."
        if self.pkce is None:
            return False, "No pending authorization - reload this page and try again."
        verifier, _ = self.pkce
        if state and state != verifier:
            return False, "State mismatch - the link expired or was regenerated. Reload and retry."
        status, data = 0, {}
        for url in TOKEN_URLS:
            status, data = self._http_json(
                url,
                "POST",
                body={
                    "grant_type": "authorization_code",
                    "code": code,
                    "state": state or verifier,
                    "redirect_uri": REDIRECT_URI,
                    "client_id": CLIENT_ID,
                    "code_verifier": verifier,
                },
                headers={"Content-Type": "application/json"},
            )
            if status == 200 and data.get("refresh_token"):
                break
        else:
            return False, f"Token exchange failed (last http {status}: {json.dumps(data)[:150]})"
        self.refresh_token = data["refresh_token"]
        self.access_token = data.get("access_token", "")
        self.expires_at = time.time() + int(data.get("expires_in", 28800))
        self.token_dead = False
        self.backoff_until = 0.0
        self._save_tokens()
        self.pkce = None
        self._set_status("token set, polling...")
        self.wake.set()
        LOG.info("new authorization stored via web UI (token len=%d)", len(self.refresh_token))
        return True, "Authorization stored - the proxy takes over from here."

    # --- usage --------------------------------------------------------------

    def poll_usage(self) -> None:
        if not self.access_token:
            return
        status, data = self._http_json(
            USAGE_URL,
            "GET",
            headers={
                "Authorization": "Bearer " + self.access_token,
                "anthropic-beta": BETA_HEADER,
            },
        )
        if status == 401:
            LOG.warning("usage: 401, clearing access token to force refresh")
            self.access_token = ""
            self.expires_at = 0.0
            self._set_status("reauth")
            return
        if status == 429:
            self.backoff_until = time.time() + RATE_LIMIT_BACKOFF
            self._set_status("rate limited")
            return
        if status != 200:
            self._set_status(f"http {status}")
            return
        with self.lock:
            fh = data.get("five_hour") or {}
            sd = data.get("seven_day") or {}
            self.session_pct = fh.get("utilization")
            self.week_pct = sd.get("utilization")
            self.session_reset_epoch = iso_to_epoch(fh.get("resets_at"))
            self.week_reset_epoch = iso_to_epoch(sd.get("resets_at"))
            self.last_ok = time.time()
        self._set_status("ok")
        LOG.info(
            "session %s%%  week %s%%",
            "?" if self.session_pct is None else f"{self.session_pct:.0f}",
            "?" if self.week_pct is None else f"{self.week_pct:.0f}",
        )
        self.publish_metrics()

    # --- MQTT ---------------------------------------------------------------

    def _supervisor_mqtt(self):
        token = os.environ.get("SUPERVISOR_TOKEN", "")
        if not token:
            return None
        req = urllib.request.Request(
            "http://supervisor/services/mqtt",
            headers={"Authorization": "Bearer " + token},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.load(resp)["data"]
            return data["host"], int(data["port"]), data.get("username"), data.get("password")
        except Exception as e:  # noqa: BLE001
            LOG.warning("supervisor mqtt service discovery failed: %s", e)
            return None

    def _connect_mqtt(self) -> None:
        creds = self._supervisor_mqtt()
        if creds:
            host, port, user, pw = creds
        elif self.opts["mqtt_host"]:
            host = self.opts["mqtt_host"]
            port = self.opts["mqtt_port"]
            user = self.opts["mqtt_username"] or None
            pw = self.opts["mqtt_password"] or None
            LOG.info("using manually configured mqtt broker %s:%s", host, port)
        else:
            LOG.error("no mqtt broker available (supervisor service down, no manual host set); retrying")
            return
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="claude_usage_proxy")
        if user:
            client.username_pw_set(user, pw)
        prefix = self.opts["topic_prefix"]
        client.will_set(f"{prefix}/status", "proxy offline", qos=1, retain=True)
        client.on_connect = self._on_mqtt_connect
        client.on_disconnect = self._on_mqtt_disconnect
        client.on_message = self._on_mqtt_message
        try:
            client.connect(host, port, keepalive=60)
        except Exception as e:  # noqa: BLE001
            LOG.warning("mqtt connect to %s:%s failed: %s", host, port, e)
            return
        client.loop_start()
        self.client = client

    def _on_mqtt_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code != 0:
            LOG.warning("mqtt connect refused: %s", reason_code)
            return
        self.mqtt_connected = True
        prefix = self.opts["topic_prefix"]
        client.subscribe(f"{prefix}/command/refresh", qos=1)
        self._publish_discovery(client)
        client.publish(f"{prefix}/status", self.status, qos=1, retain=True)  # clear the LWT
        LOG.info("mqtt connected (prefix %s)", prefix)

    def _on_mqtt_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        self.mqtt_connected = False
        LOG.warning("mqtt disconnected: %s", reason_code)

    def _on_mqtt_message(self, client, userdata, msg):
        if msg.topic.endswith("/command/refresh"):
            LOG.info("refresh requested via mqtt")
            self.backoff_until = 0.0
            self.wake.set()

    def _publish_discovery(self, client) -> None:
        if not self.opts["discovery"]:
            return
        prefix = self.opts["topic_prefix"]
        device = {
            "identifiers": ["claude_usage_proxy"],
            "name": "Claude Usage Proxy",
            "manufacturer": "fliphess",
        }
        entities = {
            "session_percent": {
                "name": "Claude Session Usage",
                "unit_of_measurement": "%",
                "state_class": "measurement",
                "icon": "mdi:progress-clock",
            },
            "week_percent": {
                "name": "Claude Weekly Usage",
                "unit_of_measurement": "%",
                "state_class": "measurement",
                "icon": "mdi:calendar-week",
            },
            "session_resets_at": {
                "name": "Claude Session Resets",
                "device_class": "timestamp",
                "icon": "mdi:clock-outline",
            },
            "week_resets_at": {
                "name": "Claude Week Resets",
                "device_class": "timestamp",
                "icon": "mdi:calendar-clock",
            },
            "status": {
                "name": "Claude Proxy Status",
                "entity_category": "diagnostic",
                "icon": "mdi:connection",
            },
        }
        for slug, cfg in entities.items():
            payload: dict = dict(cfg)
            payload["state_topic"] = f"{prefix}/{slug}"
            payload["unique_id"] = f"claude_usage_proxy_{slug}"
            if cfg.get("device_class") == "timestamp":
                # devices get the raw epoch; HA renders it as a local timestamp
                payload["value_template"] = "{{ (value | int) | timestamp_local }}"
            payload["device"] = device
            client.publish(
                f"homeassistant/sensor/claude_usage_proxy/{slug}/config",
                json.dumps(payload),
                qos=1,
                retain=True,
            )

    def publish_metrics(self) -> None:
        client = self.client
        if client is None or not self.mqtt_connected:
            return
        prefix = self.opts["topic_prefix"]

        def pub(topic: str, value) -> None:
            if value is not None:
                client.publish(f"{prefix}/{topic}", str(value), qos=1, retain=True)

        with self.lock:
            pub("session_percent", f"{self.session_pct:.4g}" if self.session_pct is not None else None)
            pub("week_percent", f"{self.week_pct:.4g}" if self.week_pct is not None else None)
            pub("session_resets_at", self.session_reset_epoch or None)
            pub("week_resets_at", self.week_reset_epoch or None)
            pub("last_update", int(self.last_ok) or None)

    def _set_status(self, status: str) -> None:
        self.status = status
        client = self.client
        if client is not None and self.mqtt_connected:
            client.publish(
                f"{self.opts['topic_prefix']}/status", status, qos=1, retain=True
            )

    # --- main loop ------------------------------------------------------------

    def _tick(self) -> None:
        if self.client is None:
            self._connect_mqtt()
            return
        now = time.time()
        if now < self.backoff_until:
            return
        if self.token_dead:
            if now >= self.dead_retry_at:
                self.dead_retry_at = now + DEAD_TOKEN_RETRY
                if self.refresh_access():
                    self.poll_usage()
            return
        if not self.access_token or now >= self.expires_at - REFRESH_MARGIN:
            if self.refresh_access():
                self.poll_usage()
            return
        if now - self.last_ok >= self.opts["poll_interval"]:
            self.poll_usage()

    def run(self) -> None:
        LOG.info(
            "claude usage proxy running (prefix=%s interval=%ss discovery=%s)",
            self.opts["topic_prefix"],
            self.opts["poll_interval"],
            self.opts["discovery"],
        )
        while not self.stop.is_set():
            try:
                self._tick()
            except Exception:  # noqa: BLE001 - never let the loop die
                LOG.exception("tick failed")
            self.wake.wait(5.0)
            self.wake.clear()


# --- web UI: one page ------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    proxy: ClaudeUsageProxy  # bound at serve time

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            flash = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("msg", [""])[0]
            self._page(flash)
        else:
            self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        path = urllib.parse.urlparse(self.path).path
        if path != "/renew":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        form = urllib.parse.parse_qs(self.rfile.read(length).decode())
        pasted = form.get("code", [""])[0]
        ok, msg = self.proxy.complete_authorize(pasted)
        if not ok:
            msg = "error: " + msg
        self.send_response(303)
        self.send_header("Location", "/?msg=" + urllib.parse.quote(msg))
        self.end_headers()

    def _page(self, flash: str = "") -> None:
        p = self.proxy
        now = time.time()
        with p.lock:
            session, week = p.session_pct, p.week_pct

        def age(ts: float) -> str:
            if not ts:
                return "never"
            d = int(now - ts)
            return f"{d}s ago" if d < 120 else f"{d // 60}m ago" if d < 7200 else f"{d // 3600}h ago"

        def pct(v) -> str:
            return "?" if v is None else f"{v:.0f}%"

        expires = ""
        if p.access_token and p.expires_at > now:
            expires = f"valid for {int((p.expires_at - now) // 60)} more minutes"
        rows = [
            ("Status", html.escape(p.status)),
            ("MQTT", "connected" if p.mqtt_connected else "not connected"),
            (
                "Refresh token",
                f"present (len {len(p.refresh_token)})" if p.refresh_token else "MISSING - renew below",
            ),
            ("Access token", expires or "none"),
            ("Last successful poll", age(p.last_ok)),
            ("Session (5h)", pct(session)),
            ("Week", pct(week)),
        ]
        table = "".join(
            f"<tr><th>{html.escape(k)}</th><td>{v}</td></tr>" for k, v in rows
        )
        auth_url = p.begin_authorize()
        flash_html = f'<p class="flash">{html.escape(flash)}</p>' if flash else ""
        body = f"""<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>Claude Usage Proxy</title>
<style>
 body {{ font-family: sans-serif; background: #0b0f14; color: #e6edf3; margin: 2rem auto; max-width: 34rem; }}
 table {{ border-collapse: collapse; width: 100%; margin-bottom: 1.5rem; }}
 th, td {{ text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #21262d; }}
 th {{ color: #7d8590; font-weight: normal; width: 40%; }}
 a, .btn {{ color: #58a6ff; }}
 .flash {{ padding: .6rem .8rem; border: 1px solid #21262d; border-radius: 6px; }}
 textarea {{ width: 100%; box-sizing: border-box; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: .5rem; }}
 input[type=submit] {{ margin-top: .5rem; padding: .45rem 1rem; background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; }}
 h1 {{ font-size: 1.3rem; }} h2 {{ font-size: 1.05rem; color: #7d8590; }}
</style></head><body>
<h1>Claude Usage Proxy</h1>
{flash_html}
<table>{table}</table>
<h2>Renew authorization (once, for all displays)</h2>
<ol>
 <li><a href="{html.escape(auth_url)}" target="_blank" rel="noreferrer">Open the Claude authorization page</a> and approve.</li>
 <li>Copy the <code>code#state</code> shown on the callback page.</li>
 <li>Paste it below.</li>
</ol>
<form method="post" action="/renew">
 <textarea name="code" rows="3" placeholder="code#state" autofocus></textarea>
 <input type="submit" value="Exchange and take over">
</form>
</body></html>"""
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args) -> None:  # noqa: A002 - http.server API
        LOG.debug("%s - %s", self.address_string(), format % args)


def main() -> None:
    proxy = ClaudeUsageProxy()
    handler = type("BoundHandler", (Handler,), {"proxy": proxy})
    httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), handler)

    threading.Thread(target=proxy.run, daemon=True).start()
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    LOG.info("web UI listening on port %d", HTTP_PORT)

    done = threading.Event()

    def shutdown(signum, frame) -> None:
        proxy.stop.set()
        proxy.wake.set()
        threading.Thread(target=httpd.shutdown).start()
        done.set()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    done.wait()
    if proxy.client:
        proxy.client.disconnect()
    LOG.info("stopped")


if __name__ == "__main__":
    main()
