# IMAP Backup

A Dovecot IMAP server whose only job is to receive mail you copy into it. No
SMTP, no delivery, no webmail: you add it as an account in Apple Mail, then copy
mailboxes from your other accounts onto it. The messages land as Maildir under
`/share`, one file per message, so incremental backups (borg, rsync, Home
Assistant backups) only move what changed.

## Setup

1. Set a password for the `backup` account (or rename it, or add more
   accounts) and start the add-on.
2. Pick how clients reach it (see [TLS](#tls)):
   - **directly** on `<home-assistant-host>:993`, with a self-signed
     certificate (Apple Mail asks once to trust it), or
   - **through a TLS proxy** with a real certificate, e.g. nginx `stream` on
     another host (example below).
3. Add the account in Apple Mail, see below.

## Apple Mail

1. **Mail → Settings → Accounts → +** → *Other Mail Account…*
2. Enter a name, any email address and the password. Mail can't find the
   server on its own and asks for details:
   - Account type: **IMAP**
   - Incoming mail server: your host name (e.g. `imap.example.com`)
   - User name: the account's `username`
   - Outgoing mail server: leave empty (this server does not send mail)
3. With a self-signed certificate Mail shows *Verify Certificate*: choose
   *Show Certificate*, tick *Always trust*, and continue.

To copy: select messages in another account, then **Message → Copy to →
IMAP Backup → folder**. Dragging between accounts can *move* (delete from the
source) depending on the account; hold **Option** while dragging to make sure
it copies. A whole mailbox: select it, select all messages (⌘A), Copy to.
Create folders first with **Mailbox → New Mailbox…** (nested folders work).

## Options

```yaml
accounts:
  - username: backup
    password: "a long password"
storage_dir: imap_backup
hostnames:
  - homeassistant.local
debug: false
# certfile: fullchain.pem
# keyfile: privkey.pem
```

- **accounts** — one login and mailbox tree each. Passwords are required,
  hashed into a passwd-file on every start (never logged). Removing an
  account only removes the login; its mail stays on disk.
- **storage_dir** — folder under `/share` for the mail. Changing it starts
  with an empty store; move the old folder yourself.
- **hostnames** — names/IPs for the self-signed certificate.
- **certfile / keyfile** — use a certificate from `/ssl` instead.
- **debug** — auth and mailbox debug logging.

## Storage

```
/share/imap_backup/
  backup/                    one folder per account (owner uid 5000, "vmail")
    Maildir/
      cur/ new/ tmp/         INBOX
      Archive/2019/Receipts/cur/…
      dovecot.index*         indexes, rebuilt from the messages if lost
```

Folders on disk mirror the folders in the client (`/` separator, UTF-8 names).
Every message is a single RFC 822 file, readable with any tool.

Home Assistant's own backups include `/share`, so a large archive makes them
large too. Exclude the folder there if another backup already covers it.

Deleting messages in the client deletes the files. Keep an independent
versioned backup of the folder (borg, snapshots) if this is your only copy.

## TLS

Only IMAPS on port 993 is offered; there is no plaintext listener.

**Self-signed (default).** Generated on first start for the names in
`hostnames`, stored in the add-on's `/data`, kept across restarts and
renewed 30 days before it expires (valid 825 days, the most macOS accepts).
A renewed or regenerated certificate has to be trusted again once.

**Certificate from `/ssl`.** Set `certfile` and `keyfile`. Restart the
add-on after the files are renewed.

**Behind a TLS proxy.** Let a proxy with a real certificate terminate TLS and
re-encrypt to the add-on, e.g. nginx on another host:

```nginx
stream {
    upstream imap_backup { server <home-assistant-ip>:993; }
    server {
        listen 993 ssl;
        ssl_certificate     /etc/letsencrypt/live/imap.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/imap.example.com/privkey.pem;
        proxy_pass       imap_backup;
        proxy_ssl        on;
        proxy_ssl_verify off;   # the add-on's certificate is self-signed
        proxy_timeout    35m;   # outlast IMAP IDLE
    }
}
```

All connections then come from the proxy's address. The per-user+IP
connection limit (50) is shared by everything behind the proxy.

## Limits

- Up to 50 simultaneous connections per account and client IP (Apple Mail
  opens many while copying).
- No quota and no message size limit.
- amd64 only.

## Development

`test/smoke.py` builds the image and runs an end-to-end check against it
(needs Docker; CI does not run it):

```console
python3 -I imap_backup/test/smoke.py
```
