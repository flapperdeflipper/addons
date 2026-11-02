#!/usr/bin/env python3
"""Smoke test for the IMAP Backup add-on image (needs Docker; not run by CI).

Builds the image, starts it with a temporary /data and /share, and does what
Apple Mail does when you drag mail onto the account: log in over TLS, list the
special-use folders, create a nested folder, APPEND a message and read it back.
Then checks the Maildir layout on "/share", that a wrong password is refused, and
that the self-signed certificate survives a restart.

    python3 -I imap_backup/test/smoke.py [--platform linux/amd64]
"""
import argparse
import imaplib
import json
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ADDON_DIR = Path(__file__).resolve().parent.parent
IMAGE = "imap-backup-smoke:test"
PORT = 19930
USER, PASSWORD = "backup", "correct horse battery staple"
MESSAGE = (
    b"From: Someone <someone@example.com>\r\n"
    b"To: backup@example.com\r\n"
    b"Subject: smoke test \xc3\xa9\r\n"
    b"Message-ID: <smoke@imap-backup>\r\n"
    b"\r\n"
    b"Hello from the smoke test.\r\n"
)


def sh(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True)


def wait_for_port(timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=1):
                return
        except OSError:
            time.sleep(0.5)
    raise SystemExit("port 993 never opened")


def connect():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return imaplib.IMAP4_SSL("127.0.0.1", PORT, ssl_context=ctx)


def peer_cert():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection(("127.0.0.1", PORT)) as raw, ctx.wrap_socket(raw) as tls:
        return tls.getpeercert(binary_form=True)


def start(name, data, share, platform):
    sh("docker", "rm", "-f", name, check=False)
    sh("docker", "run", "-d", "--init", "--name", name, *platform,
       "-p", f"127.0.0.1:{PORT}:993",
       "-v", f"{data}:/data", "-v", f"{share}:/share", IMAGE)
    wait_for_port()
    time.sleep(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", default="")
    args = parser.parse_args()
    platform = ["--platform", args.platform] if args.platform else []

    print("building", IMAGE)
    sh("docker", "build", *platform, "-t", IMAGE, str(ADDON_DIR))

    name = "imap-backup-smoke"
    with tempfile.TemporaryDirectory() as tmp:
        data, share = Path(tmp, "data"), Path(tmp, "share")
        data.mkdir()
        share.mkdir()
        (data / "options.json").write_text(json.dumps({
            "accounts": [{"username": USER, "password": PASSWORD}],
            "storage_dir": "imap_backup",
            "hostnames": ["homeassistant.local", "192.168.1.10"],
            "debug": False,
        }))
        try:
            start(name, data, share, platform)

            imap = connect()
            imap.login(USER, PASSWORD)
            typ, listing = imap.list()
            assert typ == "OK", listing
            text = b"\n".join(listing).decode()
            for flag, box in [("\\Archive", "Archive"), ("\\Sent", "Sent"), ("\\Trash", "Trash"),
                              ("\\Drafts", "Drafts"), ("\\Junk", "Junk")]:
                assert flag in text and box in text, f"{flag} {box} missing from LIST:\n{text}"
            print("ok: special-use folders", text.count("\n") + 1, "mailboxes")

            folder = '"Archive/2019/Receipts.old"'
            assert imap.create(folder)[0] == "OK"
            typ, resp = imap.append(folder, "(\\Seen)", imaplib.Time2Internaldate(time.time()), MESSAGE)
            assert typ == "OK", resp
            typ, _ = imap.select(folder)
            assert typ == "OK"
            typ, msg = imap.fetch("1", "(RFC822)")
            assert typ == "OK" and msg[0][1] == MESSAGE, msg
            imap.logout()
            print("ok: create nested folder, APPEND, FETCH round-trip")

            maildir = share / "imap_backup" / USER / "Maildir" / "Archive" / "2019" / "Receipts.old"
            files = list((maildir / "cur").iterdir()) + list((maildir / "new").iterdir())
            assert len(files) == 1, f"expected 1 message file under {maildir}, got {files}"
            print("ok: message on disk at", files[0].relative_to(share))

            try:
                bad = connect()
                bad.login(USER, "wrong")
                raise SystemExit("wrong password was accepted")
            except imaplib.IMAP4.error:
                print("ok: wrong password refused")

            cert = peer_cert()
            start(name, data, share, platform)
            assert peer_cert() == cert, "certificate changed across restart"
            print("ok: self-signed certificate kept across restart")

            imap = connect()
            imap.login(USER, PASSWORD)
            imap.select(folder, readonly=True)
            assert imap.search(None, "ALL")[1][0] == b"1"
            imap.logout()
            print("ok: mail still there after restart")
        except BaseException:
            print(sh("docker", "logs", name, check=False).stdout, file=sys.stderr)
            print(sh("docker", "logs", name, check=False).stderr, file=sys.stderr)
            raise
        finally:
            sh("docker", "rm", "-f", name, check=False)
            # Files on /share belong to vmail (5000); clean them up from inside.
            sh("docker", "run", "--rm", "-v", f"{tmp}:/t", "alpine:3.24.3",
               "rm", "-rf", "/t/data", "/t/share", check=False)
    print("smoke test passed")


if __name__ == "__main__":
    main()
