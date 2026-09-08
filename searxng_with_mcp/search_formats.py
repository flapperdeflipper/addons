#!/usr/bin/env python3
"""Ensure the SearXNG JSON API is allowed (search.formats includes json).

The bundled MCP server (mcp_server.py) always queries /search with
format=json; upstream SearXNG allows only the html output format by
default, so every search returns 403 until json is listed under
search.formats. This patches settings.yml idempotently at boot, touching
only the search:/formats: lines and preserving everything else
byte-for-byte.

Never raises on unrecognized layouts: it logs a warning and leaves the
file untouched so SearXNG still starts.

Environment:
  SEARXNG_SETTINGS  path to settings.yml (default /etc/searxng/settings.yml)
"""

import os
import re
import secrets as pysecrets
import sys

SETTINGS = os.environ.get("SEARXNG_SETTINGS", "/etc/searxng/settings.yml")
SEARCH_RE = re.compile(r"^search:[ \t]*(#.*)?$", re.MULTILINE)
FLOW_SEARCH_RE = re.compile(r"^search:\s*\{", re.MULTILINE)
FORMATS_LINE_RE = re.compile(r"^(\s*)formats:\s*(.*?)[ \t]*$")
ITEM_RE = re.compile(r"^(\s*)-\s+(.+?)\s*$")


def log(msg):
    print("[search-formats] " + msg, file=sys.stderr)


def item_name(text):
    return text.strip().strip("'\"").strip()


def line_index(content, match):
    return content[: match.start()].count("\n")


def ensure_json(content):
    """Return patched content, unchanged content, or None when the search:
    section layout is not recognized (leave the file alone)."""
    if FLOW_SEARCH_RE.search(content):
        return None
    headers = list(SEARCH_RE.finditer(content))
    if len(headers) > 1:
        return None
    if not headers:
        if content and not content.endswith("\n"):
            content += "\n"
        return content + "search:\n  formats: [html, json]\n"

    lines = content.splitlines(keepends=True)
    header_idx = line_index(content, headers[0])

    block_end = len(lines)
    for i in range(header_idx + 1, len(lines)):
        line = lines[i]
        if line.strip() and line[0] not in (" ", "\t"):
            block_end = i
            break

    fmt_idx = None
    fmt_indent = ""
    fmt_value = ""
    for i in range(header_idx + 1, block_end):
        m = FORMATS_LINE_RE.match(lines[i].rstrip("\n"))
        if m:
            fmt_idx = i
            fmt_indent = m.group(1)
            fmt_value = m.group(2).strip()
            break

    if fmt_idx is None:
        indent = "  "
        for i in range(header_idx + 1, block_end):
            m = re.match(r"^(\s+)\S", lines[i])
            if m:
                indent = m.group(1)
                break
        header = lines[header_idx]
        if not header.endswith("\n"):
            header += "\n"
        lines[header_idx] = header + indent + "formats: [html, json]\n"
        return "".join(lines)

    if fmt_value.startswith("[") and fmt_value.endswith("]"):
        inner = fmt_value[1:-1].strip()
        items = [item_name(x) for x in inner.split(",") if x.strip()]
        if "json" in items:
            return content
        items.append("json")
        lines[fmt_idx] = fmt_indent + "formats: [" + ", ".join(items) + "]\n"
        return "".join(lines)

    if fmt_value:
        return None  # unexpected scalar (e.g. templated reference) - do not touch

    item_indent = None
    last_item_idx = None
    items = []
    for i in range(fmt_idx + 1, block_end):
        stripped = lines[i].rstrip("\n")
        m = ITEM_RE.match(stripped)
        if m:
            if item_indent is None:
                item_indent = m.group(1)
            if m.group(1) == item_indent:
                items.append(item_name(m.group(2)))
                last_item_idx = i
        elif stripped.strip():
            if item_indent is not None:
                break  # first non-item key after the list ends it
    if "json" in items:
        return content
    if item_indent is None:
        item_indent = fmt_indent + "  "
        insert_at = fmt_idx + 1
    else:
        insert_at = last_item_idx + 1
    lines.insert(insert_at, item_indent + "- json\n")
    return "".join(lines)


def write_settings(content):
    tmp = SETTINGS + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.chmod(tmp, 0o644)
    os.replace(tmp, SETTINGS)


def main():
    if not os.path.exists(SETTINGS):
        content = (
            "use_default_settings: true\n"
            'server:\n  secret_key: "%s"\n'
            "search:\n  formats: [html, json]\n" % pysecrets.token_hex(32)
        )
        write_settings(content)
        log("created minimal settings.yml with json format allowed")
        return

    with open(SETTINGS) as f:
        content = f.read()

    new = ensure_json(content)
    if new is None:
        log("WARNING: unrecognized search:/formats layout - left unchanged; json API may 403")
        return
    if new != content:
        write_settings(new)
        log("added json to search.formats")
    else:
        log("search.formats already allows json")


if __name__ == "__main__":
    main()
