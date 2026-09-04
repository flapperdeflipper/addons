"""Minimal REST client for the LiteLLM proxy + response bounding helpers."""

import json
import urllib.error
import urllib.parse
import urllib.request

# Bounds so one bloated entry cannot flood an agent's context.
VALUE_LIMIT = 4000
LIST_VALUE_LIMIT = 160
LIST_ENTRY_LIMIT = 100


def truncate(text, limit):
    return text if len(text) <= limit else text[: limit - 1] + "…[truncated]"


class LitellmClient:
    """Calls the LiteLLM proxy; returns (status, parsed_json_or_error_text)."""

    def __init__(self, base_url, api_key, timeout=30):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def entry_path(self, key):
        return "/v1/memory/" + urllib.parse.quote(key, safe=":")

    def list_path(self, key_prefix=""):
        path = "/v1/memory"
        if key_prefix:
            path += "?key_prefix=" + urllib.parse.quote(key_prefix, safe=":")
        return path

    def request(self, method, path, body=None):
        if not self.api_key:
            return 0, "no API key: set LITELLM_MASTER_KEY or LITELLM_MEMORY_KEY"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.api_key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
                return resp.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            return err.code, err.read().decode("utf-8", "replace")[:300]
        except urllib.error.URLError as err:
            return 0, "cannot reach LiteLLM at %s: %s" % (self.base_url, err.reason)

    def error(self, status, detail):
        if isinstance(detail, str):
            return "error (HTTP %s): %s" % (status, detail)
        return "error (HTTP %s): %s" % (status, json.dumps(detail))


def compact(obj):
    return json.dumps(obj, separators=(",", ":"))
