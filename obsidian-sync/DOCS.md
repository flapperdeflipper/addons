# Obsidian Sync

CouchDB set up as a backend for the [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin in Obsidian.

Fork of [alexbelgium's `obsidian_syncserver_solo`](https://github.com/alexbelgium/hassio-addons/tree/master/obsidian_syncserver_solo) (MIT), renamed and hardened for this repository.

## What the add-on configures

A stock CouchDB will not work as a LiveSync backend. On every start this add-on applies the settings the plugin needs, matching what upstream's own provisioning tool does:

| Setting | Value | Why |
| :--- | :--- | :--- |
| `chttpd/require_valid_user` | `true` | No anonymous access |
| `chttpd_auth/require_valid_user` | `true` | No anonymous access to the auth endpoints |
| `httpd/WWW-Authenticate` | `Basic realm="couchdb"` | Prompts for credentials |
| `httpd/enable_cors`, `chttpd/enable_cors` | `true` | Obsidian behaves like a browser client |
| `cors/credentials` | `true` | Lets it send the auth header cross-origin |
| `cors/origins` | `app://obsidian.md,capacitor://localhost,http://localhost` | Desktop and mobile app origins |
| `chttpd/max_http_request_size` | `4294967296` | Large vault batches |
| `couchdb/max_document_size` | `50000000` | Large notes and attachments |

These get re-applied on each start, so editing them by hand in Fauxton will not stick.

## Configuration

```yaml
username: admin
password: ""
database: obsidian
log_level: info
```

`username` and `password` are the CouchDB administrator credentials that the LiveSync plugin uses. A blank password gets generated on first start and saved to `/config/obsidian-syncserver/admin_password` — it is deliberately not printed in the add-on log. On the host:

```bash
cat /addon_configs/*_obsidian-sync/obsidian-syncserver/admin_password
```

`database` is the CouchDB database holding your vault. The add-on creates it if it does not exist.

## Storage and backups

The vault database lives in `/config/obsidian-syncserver/data` (the add-on's config folder under `/addon_configs`), rather than the add-on's `/data` directory — so it survives a reinstall and is included in Home Assistant backups.

## Migrating from the alexbelgium add-on

This fork uses the same internal layout, so migrating is a plain directory copy. On the host:

```bash
# stop the old add-on first, then:
mkdir -p /addon_configs/4e94d283_obsidian-sync
cp -a /addon_configs/db21ed7f_obsidian_syncserver_solo/obsidian-syncserver \
      /addon_configs/4e94d283_obsidian-sync/
```

Then install this add-on from this repository, keep `username`/`password` identical (or leave the password blank — the copied `admin_password` file is reused), and start it. Nothing changes on the Obsidian side: same URL, same port, same credentials.

## Reverse proxy setup

Mobile Obsidian refuses plain HTTP, so a phone or tablet needs TLS in front of this add-on. Any proxy will do, as long as it does three things:

- Pass the `Authorization` header through untouched. CouchDB authenticates every single request, so a proxy that strips or rewrites that header turns everything into a 401.
- Allow WebSocket upgrades. LiveSync uses continuous replication. Without upgrade support the connection looks like it works and then just sits there.
- Avoid buffering responses indefinitely, or the long-poll changes feed lags behind.

### Nginx Proxy Manager

Add a Proxy Host:

- Domain Names: whatever hostname you plan to use, say `obsidian.example.com`
- Scheme: `http`
- Forward Hostname / IP: your Home Assistant machine
- Forward Port: `5984`
- Websockets Support: on
- On the SSL tab, request or select a certificate and turn on Force SSL

Then point LiveSync at `https://obsidian.example.com`.

### Plain nginx

```nginx
location / {
    proxy_pass http://homeassistant.local:5984;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # CouchDB authenticates every request
    proxy_pass_request_headers on;

    # LiveSync uses continuous replication
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_buffering off;
    proxy_read_timeout 600s;
}
```

## Troubleshooting

If the add-on stops right after starting, read the log. A malformed `database` name or a config directory CouchDB cannot write to will both halt startup with a message saying which.

If LiveSync reports a network or CORS error, it is nearly always the proxy rather than CouchDB. Check the server directly first:

```bash
curl -u admin:YOURPASSWORD http://homeassistant.local:5984/obsidian
```

When that works but the plugin still fails, the proxy is either dropping the `Authorization` header or blocking the WebSocket upgrade.

If desktop syncs but mobile does not, the app does not trust your certificate. Self-signed ones generally will not cut it.

If sync connects and then stalls, the WebSocket upgrade is not getting through the proxy.

To see the applied configuration:

```bash
curl -u admin:YOURPASSWORD http://homeassistant.local:5984/_node/_local/_config/cors
```

The Obsidian origins should be listed there.

## Security notes

- Plain HTTP on port 5984 by design; put a reverse proxy with TLS in front for anything off-LAN or mobile use.
- The generated admin password is never logged; it lives only in the add-on's config folder with `0600` permissions.
- The AppArmor profile allows CouchDB's Erlang VM the broad file/network access it needs, adds explicit `signal (receive)` rules so `docker stop` shuts CouchDB down cleanly (SIGTERM instead of SIGKILL), and denies writes to `/proc/kcore`, `/proc/sysrq-trigger` and `/sys/firmware`.
