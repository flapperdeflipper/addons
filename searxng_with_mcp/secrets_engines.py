#!/usr/bin/env python3
"""Inject managed SearXNG engines (github code + gitlab) into settings.yml.

The github_token option supports HA-style '!secret <key>' values: the
Supervisor resolves them against secrets.yaml itself, and run.sh passes the
resolved token here via environment. This script never reads secrets.yaml.

Owns only the text between BEGIN/END markers in /etc/searxng/settings.yml;
everything else in the file is preserved byte-for-byte. Token values are
never logged.

Environment:
  GHC_TOKEN       resolved GitHub PAT ("" = github code engine disabled)
  GITLAB_ENGINE   "true"/"false" - add the gitlab.com engine (no token
                  support upstream; searches public projects)
"""

import os
import re
import secrets as pysecrets
import sys

SETTINGS = "/etc/searxng/settings.yml"
BEGIN = "# BEGIN addon managed engines (auto-generated at boot - do not edit between markers)"
END = "# END addon managed engines"
ENGINES_RE = re.compile(r"^engines:[ \t]*(#.*)?$", re.MULTILINE)

GHC_TOKEN = (os.environ.get("GHC_TOKEN") or "").strip()
WANT_GITLAB = (os.environ.get("GITLAB_ENGINE", "true").strip().lower() or "true") not in ("false", "0", "no")


def log(msg):
    print("[secrets-engines] " + msg, file=sys.stderr)


def detect_list_indent(content):
    """Indentation of the existing entries under `engines:` (0 when none/absent)."""
    match = ENGINES_RE.search(content)
    if not match:
        return 0
    for line in content[match.end() :].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        item = re.match(r"^(\s*)- ", line)
        return len(item.group(1)) if item else 0
    return 0


def indent_entry(entry, indent):
    pad = " " * indent
    return "\n".join((pad + line) if line else line for line in entry.splitlines())


def build_block(indent=0):
    entries = []
    if GHC_TOKEN:
        entries.append(
            "- name: github code\n"
            "  engine: github_code\n"
            "  shortcut: ghc\n"
            "  ghc_auth:\n"
            "    type: personal_access_token\n"
            "    token: %s\n"
            "  ghc_highlight_matching_lines: true\n"
            "  ghc_strip_new_lines: true" % GHC_TOKEN
        )
    if WANT_GITLAB:
        entries.append(
            "- name: gitlab\n"
            "  engine: gitlab\n"
            "  base_url: https://gitlab.com\n"
            "  shortcut: gl"
        )
    if not entries:
        return ""
    return BEGIN + "\n" + "\n".join(indent_entry(e, indent) for e in entries) + "\n" + END


def write_settings(content):
    tmp = SETTINGS + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.chmod(tmp, 0o644)
    os.replace(tmp, SETTINGS)


def main():
    if os.path.exists(SETTINGS):
        with open(SETTINGS) as f:
            existing = f.read()
        block = build_block(detect_list_indent(existing))
    else:
        existing = None
        block = build_block(0)

    if not os.path.exists(SETTINGS):
        if not block:
            return  # nothing enabled; let the SearXNG entrypoint write its default
        content = (
            "use_default_settings: true\n"
            'server:\n  secret_key: "%s"\n'
            "engines:\n" % pysecrets.token_hex(32)
        ) + block + "\n"
        write_settings(content)
        log("created minimal settings.yml with managed engines")
        return

    content = existing

    if BEGIN in content:
        start = content.index(BEGIN)
        end = content.index(END) + len(END)
        new = content[:start] + (block if block else "") + content[end:]
        if not block:
            new = re.sub(r"\n{3,}", "\n\n", new)
    elif not block:
        return
    else:
        match = ENGINES_RE.search(content)
        if match:
            new = content[: match.end()] + "\n" + block + content[match.end() :]
        else:
            if not content.endswith("\n"):
                content += "\n"
            new = content + "engines:\n" + block + "\n"

    if new != content:
        write_settings(new)
        log("settings.yml updated")
    else:
        log("settings.yml already up to date")


if __name__ == "__main__":
    main()
