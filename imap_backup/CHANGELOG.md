# Changelog

## 1.0.0 (2026-11-02)

Initial release.

- **New:** Dovecot 2.4 IMAP server (Alpine 3.24) as a place to copy mail into from other accounts, e.g. with Apple Mail
- **New:** accounts in the add-on options, hashed (SHA512-CRYPT) into a passwd-file on every start; passwords never on a command line or in the log
- **New:** mail stored as Maildir under `/share/<storage_dir>/<account>/Maildir`, folders nested on disk as in the client (`/` separator, UTF-8 names)
- **New:** IMAPS only on port 993; certificate from `/ssl` or a self-signed one (≤ 825 days so macOS accepts it, renewed 30 days before expiry, kept across restarts)
- **New:** special-use folders Archive, Drafts, Junk, Sent and Trash, so Apple Mail does not create its own "Deleted Messages" and friends
- **New:** 50 connections per user and IP (Dovecot's default 10 breaks large drag-and-drop copies in Apple Mail)
- **New:** `test/smoke.py`, a Docker-based end-to-end check (login, LIST, CREATE, APPEND, FETCH, Maildir on disk, wrong password, restart)
