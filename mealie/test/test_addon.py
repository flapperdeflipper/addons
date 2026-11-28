#!/usr/bin/env python3
"""Mealie add-on checks: manifest sanity and addon-run.sh option handling.

rootfs/addon-run.sh is executed for real with its fixed paths (/data/options.json,
/data/mealie, /run/mealie-secrets, /app/run.sh) rewritten into a temp dir and
the upstream entrypoint replaced by a stub that dumps its environment. chown
is stubbed too, so the suite runs unprivileged. Plain python3, no pytest.
"""

import json
import os
import re
import stat
import subprocess
import sys
import tempfile

ADDON_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ADDON_DIR, "config.yaml"), encoding="utf-8") as fh:
    CONFIG = fh.read()
with open(os.path.join(ADDON_DIR, "rootfs", "addon-run.sh"), encoding="utf-8") as fh:
    RUN_SH = fh.read()

BASE_OPTIONS = {
    "base_url": "",
    "trusted_proxies": "",
    "allow_password_login": True,
    "token_time_hours": 48,
    "max_upload_size_mb": 1024,
    "http_allow_list": "",
    "log_level": "info",
    "oidc": {
        "enabled": False,
        "configuration_url": "",
        "client_id": "",
        "client_secret": "",
        "provider_name": "OAuth",
        "signup_enabled": True,
        "user_group": "",
        "admin_group": "",
        "auto_redirect": False,
        "remember_me": False,
    },
}

BASE_OPTIONS["postgres"] = {
    "enabled": False,
    "server": "",
    "port": 5432,
    "database": "mealie",
    "user": "mealie",
    "password": "",
}

POSTGRES_OPTIONS = dict(
    BASE_OPTIONS,
    postgres=dict(BASE_OPTIONS["postgres"], enabled=True, server="db.example.org", password="not-a-real-password"),
)

OIDC_OPTIONS = dict(
    BASE_OPTIONS,
    base_url="https://recipes.example.org/",
    oidc=dict(
        BASE_OPTIONS["oidc"],
        enabled=True,
        configuration_url="https://git.example.org/.well-known/openid-configuration",
        client_id="client-id",
        client_secret="not-a-real-secret",
        admin_group="admins",
    ),
)


def run_addon(options):
    """Run run.sh against options; return (exit code, stderr, env dict, tmp)."""
    tmp = tempfile.mkdtemp(prefix="mealie-test-")
    data = os.path.join(tmp, "data")
    os.makedirs(data)
    with open(os.path.join(data, "options.json"), "w", encoding="utf-8") as fh:
        json.dump(options, fh)

    stub = os.path.join(tmp, "upstream-run.sh")
    with open(stub, "w", encoding="utf-8") as fh:
        fh.write('#!/bin/bash\nenv > "%s/env.out"\n' % tmp)
    os.chmod(stub, stat.S_IRWXU)

    bindir = os.path.join(tmp, "bin")
    os.makedirs(bindir)
    chown = os.path.join(bindir, "chown")
    with open(chown, "w", encoding="utf-8") as fh:
        fh.write("#!/bin/sh\nexit 0\n")
    os.chmod(chown, stat.S_IRWXU)

    script = (
        RUN_SH.replace("/data/options.json", os.path.join(data, "options.json"))
        .replace("DATA_DIR=/data/mealie", "DATA_DIR=" + os.path.join(data, "mealie"))
        .replace(
            "SECRETS_DIR=/run/mealie-secrets",
            "SECRETS_DIR=" + os.path.join(tmp, "secrets"),
        )
        .replace("exec /app/run.sh", "exec " + stub)
    )
    script_path = os.path.join(tmp, "run.sh")
    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(script)

    env = {"PATH": bindir + os.pathsep + os.environ.get("PATH", "")}
    proc = subprocess.run(
        ["bash", script_path], capture_output=True, text=True, env=env, check=False
    )

    out_env = {}
    env_out = os.path.join(tmp, "env.out")
    if os.path.exists(env_out):
        with open(env_out, encoding="utf-8") as fh:
            for line in fh:
                key, _, value = line.rstrip("\n").partition("=")
                out_env[key] = value
    return proc.returncode, proc.stdout + proc.stderr, out_env, tmp


def test_manifest_version_is_plain_semver():
    assert re.search(r'^version:\s*"?\d+\.\d+\.\d+"?\s*$', CONFIG, re.M), (
        "version must be plain semver"
    )


def test_manifest_slug_matches_directory():
    slug = re.search(r'^slug:\s*"?(\S+?)"?\s*$', CONFIG, re.M)
    assert slug and slug.group(1) == os.path.basename(ADDON_DIR), (
        "slug does not match directory name"
    )


def test_manifest_backup_is_cold():
    assert re.search(r"^backup:\s*cold\s*$", CONFIG, re.M), (
        "SQLite data needs backup: cold"
    )


def test_manifest_client_secret_is_password():
    assert re.search(r"^\s+client_secret:\s*password\?\s*$", CONFIG, re.M), (
        "client_secret schema must be password"
    )


def test_dockerfile_pins_release_tag():
    with open(os.path.join(ADDON_DIR, "Dockerfile"), encoding="utf-8") as fh:
        dockerfile = fh.read()
    assert re.search(
        r"^FROM ghcr\.io/mealie-recipes/mealie:v\d+\.\d+\.\d+$", dockerfile, re.M
    ), "FROM must pin an immutable vX.Y.Z tag"


def test_defaults_trust_no_proxy_and_disable_signup():
    code, log, env, _ = run_addon(BASE_OPTIONS)
    assert code == 0, log
    assert env.get("HOST_IP") == "", (
        "empty trusted_proxies must export HOST_IP='' (trust none)"
    )
    assert env.get("ALLOW_SIGNUP") == "false"
    assert env.get("OIDC_AUTH_ENABLED") == "false"
    assert "BASE_URL" not in env
    assert env.get("DATA_DIR", "").endswith("/data/mealie")


def test_wildcard_proxy_is_refused():
    code, log, env, _ = run_addon(dict(BASE_OPTIONS, trusted_proxies="*"))
    assert code != 0 and not env, "trusted_proxies '*' must stop startup"
    assert "trusted_proxies" in log


def test_oidc_secret_goes_to_file_not_env():
    code, log, env, _ = run_addon(OIDC_OPTIONS)
    assert code == 0, log
    assert "OIDC_CLIENT_SECRET" not in env, "wrapper must pass the secret as a file, not an env var"
    path = env.get("OIDC_CLIENT_SECRET_FILE", "")
    with open(path, encoding="utf-8") as fh:
        assert fh.read() == "not-a-real-secret"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o400
    assert "not-a-real-secret" not in log, "secret leaked into the log"
    assert env.get("BASE_URL") == "https://recipes.example.org"
    assert env.get("OIDC_ADMIN_GROUP") == "admins"
    assert "OIDC_USER_GROUP" not in env


def test_oidc_missing_fields_fail_closed():
    for key in ("configuration_url", "client_id", "client_secret"):
        opts = dict(OIDC_OPTIONS, oidc=dict(OIDC_OPTIONS["oidc"], **{key: ""}))
        code, log, env, _ = run_addon(opts)
        assert code != 0 and not env, "empty oidc.%s must stop startup" % key


def test_oidc_unresolved_secret_fails_closed():
    opts = dict(
        OIDC_OPTIONS,
        oidc=dict(OIDC_OPTIONS["oidc"], client_secret="!secret missing_key"),
    )
    code, log, env, _ = run_addon(opts)
    assert code != 0 and not env
    assert "unresolved" in log


def test_oidc_needs_base_url():
    code, _, env, _ = run_addon(dict(OIDC_OPTIONS, base_url=""))
    assert code != 0 and not env


def test_no_login_method_is_refused():
    code, _, env, _ = run_addon(dict(BASE_OPTIONS, allow_password_login=False))
    assert code != 0 and not env


def test_manifest_postgres_password_is_password():
    assert re.search(r"^\s+password:\s*password\?\s*$", CONFIG, re.M), (
        "postgres.password schema must be password"
    )


def test_sqlite_is_the_default():
    code, log, env, _ = run_addon(BASE_OPTIONS)
    assert code == 0, log
    assert env.get("DB_ENGINE") == "sqlite"
    assert not any(k.startswith("POSTGRES_") for k in env)


def test_postgres_password_goes_to_file_not_env():
    code, log, env, _ = run_addon(POSTGRES_OPTIONS)
    assert code == 0, log
    assert env.get("DB_ENGINE") == "postgres"
    assert env.get("POSTGRES_SERVER") == "db.example.org"
    assert env.get("POSTGRES_PORT") == "5432"
    assert env.get("POSTGRES_DB") == "mealie" and env.get("POSTGRES_USER") == "mealie"
    assert env.get("PGSSLMODE") == "require", "the remote database connection must require TLS"
    assert "POSTGRES_PASSWORD" not in env, "wrapper must pass the password as a file, not an env var"
    path = env.get("POSTGRES_PASSWORD_FILE", "")
    with open(path, encoding="utf-8") as fh:
        assert fh.read() == "not-a-real-password"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o400
    assert "not-a-real-password" not in log, "password leaked into the log"


def test_postgres_missing_fields_fail_closed():
    for key in ("server", "database", "user", "password"):
        opts = dict(POSTGRES_OPTIONS, postgres=dict(POSTGRES_OPTIONS["postgres"], **{key: ""}))
        code, log, env, _ = run_addon(opts)
        assert code != 0 and not env, "empty postgres.%s must stop startup" % key


def test_postgres_unresolved_secret_fails_closed():
    opts = dict(POSTGRES_OPTIONS, postgres=dict(POSTGRES_OPTIONS["postgres"], password="!secret missing_key"))
    code, log, env, _ = run_addon(opts)
    assert code != 0 and not env
    assert "unresolved" in log


def main():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok -", name)
            except (AssertionError, OSError) as err:
                failures += 1
                print("FAIL -", name, "-", err)
    print("%d failures" % failures)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
