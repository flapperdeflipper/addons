# Changelog

## 3.8.2 (2026-09-26)

- **Changed:** map type `addon_config` -> `app_config` (same volume, new Supervisor naming); clears the Supervisor legacy-map validation warning

## 3.8.1 (2026-09-26)

- **Fixed:** server-admin assertion could invalidate its own credentials mid-run — asserting the bootstrap admin with a changed password broke authentication for the remaining iterations (requests went out unauthenticated) and for the rest of provisioning (`401` at `require_valid_user`). The convergence loop now runs LAST, skips no-op self-assertions, and adopts a changed bootstrap password immediately
- **Docs:** multiple `server_admin: true` logins are supported and re-asserted every start; `[admins]` lives in the container-ephemeral local.ini, which is fine because the loop converges on every start

## 3.8.0 (2026-09-26)

The options are leading: every start converges the full declared state.

- **New:** multiple `server_admin: true` logins are supported (CouchDB natively allows several server administrators). The first remains the bootstrap admin for the image entrypoint; every start re-asserts ALL of them via `_config/admins`, so server-admin password or username changes apply on restart. Removing a login from the options still does not revoke an existing administrator (non-destructive contract)
- **Changed:** rights now converge on the declared level — a user moved between `member` and `admin` in the options is moved between the security object's buckets on the next start instead of accumulating in both. Role arrays (e.g. LiveSync's `_admin`) are preserved
- Already the case, now documented: user passwords are re-asserted on every start (`_users` upsert), databases/CORS/hardening re-applied, so any options change lands on the next restart

## 3.7.1 (2026-09-26)

- **Fixed:** `!secret <key>` references in `databases` and `rights[].database` were resolved and stored as plain values at save time — the `match()` schema constraint forced Supervisor to validate (and persist) the expanded value. Schema relaxed to plain `str` so references persist in stored options and expand when the container starts (same behaviour as the MariaDB add-on); run.sh keeps validating database names with a clear error
- **Robustness:** run.sh refuses to start if any `!secret …` value is still unresolved in /data/options.json (missing key in secrets.yaml) instead of provisioning garbage

## 3.7.0 (2026-09-26)

Separates the two kinds of admin that coexist in the options, and makes the non-destructive contract explicit.

- **Breaking (options):** login flag `admin:` renamed to `server_admin:` — the CouchDB **server** administrator. Stored options with the old key must be re-saved before the add-on will start. `level: admin` in `rights:` keeps meaning **database** admin (design docs + Mango indexes); defaults now grant it to the vault user on the vault database (Obsidian LiveSync creates its indexes there) and to the docstore user on the agent databases
- **Robustness:** docstore indexes now use explicit named design documents (`docstore-*`) — deterministic across restarts, clearly ours, never colliding with or redefining user- or LiveSync-created indexes
- **Documented contract:** provisioning is non-destructive by design — it only creates and adds; removing an entry from the options never deletes or revokes the live object; the only automated deleter is the TTL sweeper (expired documents in registry databases only)

## 3.6.1 (2026-09-26)

- **Fixed:** docstore MCP exited at startup when the docstore user's password was generated (blank in options) — run.sh now passes the resolved password via `DOCSTORE_PASSWORD`/`DOCSTORE_USERNAME` env instead of the server re-reading options.json

## 3.6.0 (2026-09-26)

**Renamed `obsidian-sync` → `couchdb`** and generalized into a plain CouchDB add-on with MariaDB-style declarative management. The new slug makes Supervisor treat this as a new add-on; see DOCS.md "Migrating from obsidian-sync" for the one-step data move.

- **New:** `databases` option — list of databases, created idempotently on every start
- **New:** `logins` option — regular CouchDB users upserted in `_users`; exactly one `admin: true` login is the server administrator; blank passwords are generated per user and persisted under `/config/couchdb/users/` (never logged)
- **New:** `rights` option — per-database `member`/`admin` grants merged into `_security`, replacing the single-vault model; databases without members stay authenticated-public
- **New:** `cors.origins` option — CORS origins instead of hardcoded Obsidian origins (defaults preserve LiveSync behaviour; empty disables CORS)
- **New:** agent docstore — registry-validated MCP endpoint on internal port 5985 (`doc_get/put/update/delete/query`, `task_claim/complete`), bearer token, hourly TTL sweeper; registry editable at `/config/couchdb/docstore/registry.json`; self-running tests under `test/`
- **Kept:** LiveSync provisioning as defaults, `/config`-backed storage (backup-safe), generated-admin-password behaviour, single-node bootstrap, request/auth hardening
- **Migration:** the obsidian-sync era generated admin password is adopted automatically; LiveSync clients need no changes (administrator bypasses per-database rights)

## 3.5.2.2 (2026-09-20)

Initial release in this repository — fork of [alexbelgium/hassio-addons `obsidian_syncserver_solo`](https://github.com/alexbelgium/hassio-addons/tree/master/obsidian_syncserver_solo) (MIT), renamed to **obsidian-sync**.

- **Fixed:** allow the container to receive signals from runc/docker — `docker stop` escalated straight to SIGKILL (unclean CouchDB shutdown) and flooded the host audit log with `apparmor="DENIED" operation="signal" signal=kill peer="runc"`
- **Security:** stop printing the generated admin password into the add-on log (Supervisor logs end up in diagnostics/support bundles); it is only stored in `/config/obsidian-syncserver/admin_password`
- **Cleanup:** drop the `ripgrep` package (a plain `grep -qi` covers it), drop the `_ssl` flavour hook, drop the hardcoded `io.hass.*` labels (the builder injects them)
- **Packaging:** published as `flapperdeflipper/addon-obsidian-sync`, amd64 only

## 3.5.2.1 (2026-08-13, upstream)

- Update to latest version from library/couchdb — upstream tag `3.5.2.1-nouveau`

## 3.5.2 (2026-08-12, upstream)

- Initial release wrapping couchdb:3.5.2 as an Obsidian Self-hosted LiveSync backend
- Applies the CouchDB configuration LiveSync requires on every start: single-node cluster, CORS for Obsidian app origins, mandatory authentication, 4 GB max request size, 50 MB max document size
- Creates the vault database automatically
- Generates and persists a strong admin password when none is set
- Stores data under `/config/obsidian-syncserver/data` so it survives reinstalls and is included in Home Assistant backups
