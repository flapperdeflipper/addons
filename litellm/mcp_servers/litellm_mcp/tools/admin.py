"""LiteLLM proxy admin tools (/v1/tool, /v1/models, /key/list, /spend/logs).

Read-mostly administration surface for agents: inspect and change tool trust
policies, list models and virtual keys, and review recent failed requests.
Authenticates with LITELLM_MASTER_KEY (falls back to the injected client key)
because these endpoints need admin rights the memory key does not have.
"""

import os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from ..config import MASTER_KEY_ENV
from ..litellm_client import LIST_ENTRY_LIMIT, compact, truncate

NAME = "admin"
DESCRIPTION = "LiteLLM proxy administration: tool policies, models, keys, failed requests"

INPUT_POLICIES = ("trusted", "untrusted", "blocked")
OUTPUT_POLICIES = ("trusted", "untrusted")
FAILURE_LIMIT = 50
ERROR_LIMIT = 160


def register(server, client):
    admin = client.with_key(os.environ.get(MASTER_KEY_ENV, ""))

    @server.tool()
    def admin_tool_policy_list(input_policy: str = "") -> str:
        """List auto-discovered tools and their trust policies.

        Optional input_policy filter: 'trusted', 'untrusted' or 'blocked'.
        Returns per tool: input_policy, output_policy and call count. Bounded
        at 100 rows; use the filter to see the rest.
        """
        if input_policy and input_policy not in INPUT_POLICIES:
            return "invalid input_policy: must be one of %s" % (INPUT_POLICIES,)
        path = "/v1/tool/list"
        if input_policy:
            path += "?" + urlencode({"input_policy": input_policy})
        status, body = admin.request("GET", path)
        if status != 200:
            return client.error(status, body)
        tools = body.get("tools", []) if isinstance(body, dict) else []
        shown = [
            {
                "tool": t.get("tool_name", ""),
                "input": t.get("input_policy"),
                "output": t.get("output_policy"),
                "calls": t.get("call_count"),
            }
            for t in tools[:LIST_ENTRY_LIMIT]
        ]
        result = compact({"tools": shown, "shown": len(shown), "total": body.get("total", len(tools))})
        if len(tools) > LIST_ENTRY_LIMIT:
            result += " [truncated at %d rows - filter by input_policy]" % LIST_ENTRY_LIMIT
        return result

    @server.tool()
    def admin_tool_policy_set(
        tool_name: str,
        input_policy: str = "",
        output_policy: str = "",
        team_id: str = "",
        key_hash: str = "",
    ) -> str:
        """Set the input_policy and/or output_policy for a tool. Takes effect
        immediately (no proxy restart).

        input_policy: 'trusted' (only allow when the conversation contains no
        untrusted tool output), 'untrusted' (default, always allow) or
        'blocked' (always reject). output_policy: 'trusted' or 'untrusted'
        (default). A tool marked input_policy=trusted is blocked by its own
        output unless its output_policy is also trusted. team_id/key_hash
        scope a 'blocked' override to one team or key.
        """
        tool_name = (tool_name or "").strip()
        if not tool_name:
            return "tool_name must not be empty"
        if input_policy and input_policy not in INPUT_POLICIES:
            return "invalid input_policy: must be one of %s" % (INPUT_POLICIES,)
        if output_policy and output_policy not in OUTPUT_POLICIES:
            return "invalid output_policy: must be one of %s" % (OUTPUT_POLICIES,)
        if not input_policy and not output_policy:
            return "provide input_policy and/or output_policy"
        body = {"tool_name": tool_name}
        if input_policy:
            body["input_policy"] = input_policy
        if output_policy:
            body["output_policy"] = output_policy
        if team_id:
            body["team_id"] = team_id
        if key_hash:
            body["key_hash"] = key_hash
        status, resp = admin.request("POST", "/v1/tool/policy", body)
        if status != 200:
            return client.error(status, resp)
        return compact(resp)

    @server.tool()
    def admin_models() -> str:
        """List the model names deployed on the proxy (public model list)."""
        status, body = admin.request("GET", "/v1/models")
        if status != 200:
            return client.error(status, body)
        data = body.get("data", []) if isinstance(body, dict) else []
        ids = [m.get("id", "") for m in data[:200] if isinstance(m, dict)]
        return compact({"models": ids, "total": len(ids)})

    @server.tool()
    def admin_keys() -> str:
        """List virtual keys with alias, team, budget and expiry. Token values
        are never returned - only metadata.
        """
        status, body = admin.request("GET", "/key/list")
        if status != 200:
            return client.error(status, body)
        keys = body.get("keys", []) if isinstance(body, dict) else []
        shown = [
            {
                "alias": k.get("key_alias"),
                "team_id": k.get("team_id"),
                "expires": k.get("expires"),
                "max_budget": k.get("max_budget"),
                "spend": k.get("spend"),
                "blocked": k.get("blocked"),
            }
            for k in keys[:LIST_ENTRY_LIMIT]
        ]
        result = compact({"keys": shown, "shown": len(shown), "total": len(keys)})
        if len(keys) > LIST_ENTRY_LIMIT:
            result += " [truncated at %d keys]" % LIST_ENTRY_LIMIT
        return result

    @server.tool()
    def admin_failed_requests(hours: int = 24) -> str:
        """Summarize failed requests (guardrail blocks, auth and budget errors)
        over the last N hours, default 24, max 168. Shows time, key alias,
        model and the truncated error message for each failure.
        """
        hours = max(1, min(int(hours or 24), 168))
        end = datetime.now(timezone.utc)
        start = end - timedelta(hours=hours)
        path = "/spend/logs/ui?" + urlencode(
            {
                "start_date": start.strftime("%Y-%m-%d %H:%M:%S"),
                "end_date": end.strftime("%Y-%m-%d %H:%M:%S"),
                "page_size": 100,
            }
        )
        status, body = admin.request("GET", path)
        if status != 200:
            return client.error(status, body)
        entries = body.get("data", []) if isinstance(body, dict) else []
        failures = []
        for e in entries:
            meta = e.get("metadata") or {}
            if meta.get("status") != "failure":
                continue
            err = (meta.get("error_information") or {}).get("error_message") or ""
            failures.append(
                {
                    "t": e.get("startTime"),
                    "key": meta.get("user_api_key_alias"),
                    "model": e.get("model_group") or e.get("model"),
                    "error": truncate(str(err), ERROR_LIMIT),
                }
            )
            if len(failures) >= FAILURE_LIMIT:
                break
        return compact(
            {
                "failures": failures,
                "shown": len(failures),
                "scanned": len(entries),
                "window_hours": hours,
            }
        )
