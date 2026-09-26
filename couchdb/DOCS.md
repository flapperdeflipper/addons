# CouchDB

CouchDB as a plain Home Assistant add-on with declarative, MariaDB-style
management: databases, logins and per-database rights in the options, applied
idempotently on every start.

It serves two workloads here:

- **Obsidian LiveSync** vaults (this add-on's origin — the default CORS
  origins are the Obsidian app origins, and the vault database `obsidian` is
  in the default options).
- **Agent docstore** — a registry-validated MCP endpoint (`doc_*` tools) over
  the agent databases, with an hourly TTL sweeper.

Fork history: alexbelgium/hassio-addons `obsidian_syncserver_solo` (MIT) →
this repo's `obsidian-sync` → generalized into `couchdb` in 3.6.0.

## What the add-on configures on every start

| Setting | Value | Why |
| :--- | :--- | :--- |
| `chttpd/require_valid_user`, `chttpd_auth/require_valid_user` | `true` | No anonymous access |
| `httpd/WWW-Authenticate` | `Basic realm="couchdb"` | Prompts for credentials |
| `httpd/enable_cors`, `chttpd/enable_cors`, `cors/credentials` | from `cors.origins` | Browser-like clients (Obsidian) |
| `chttpd/max_http_request_size` | `4294967296` | Large vault batches |
| `couchdb/max_document_size` | `50000000` | Large notes/attachments |
| databases from `databases` | created if missing | 412 = already exists |
| users from `logins` | upserted in `_users` | password change applies on restart |
| rights from `rights` | merged into `_security` | members/admins per database |

Hand-edits to these in Fauxton are repaired on the next start.

**Non-destructive by design:** provisioning only creates and adds. Removing a
database, login or right from the options never deletes or revokes anything
inside CouchDB — clean-up is a manual, deliberate act. The only automated
deleter is the docstore sweeper (expired documents in registry databases,
nothing else). `server_admin: true` (logins) is the CouchDB **server**
administrator; `level: admin` (rights) is a **database** administrator —
design documents and Mango indexes need the latter, which is why the LiveSync
vault user and the docstore user both use it on their own databases.

**Upgrading from 3.6.x:** the login flag `admin:` was renamed to
`server_admin:`. Stored options with the old key fail the new schema —
after updating, re-save the options with `server_admin: true` on the
administrator login, then start.

## Options

```yaml
log_level: info
databases:
  - obsidian
  - agent_handoffs
  - agent_tasks
  - agent_reports
  - agent_memory
logins:
  - username: admin      # exactly one server_admin: true
    password: ""         # blank -> generated, persisted, never logged
    server_admin: true
  - username: vault      # LiveSync client account
    password: ""
  - username: agent      # docstore MCP + human Fauxton review account
    password: ""
rights:
  - {database: obsidian,       username: vault, level: admin}   # LiveSync creates indexes
  - {database: agent_handoffs, username: agent, level: admin}   # docstore creates indexes
  # ...one row per database/user pair
cors:
  origins:
    - app://obsidian.md
    - capacitor://localhost
    - http://localhost
docstore:
  enabled: true
  username: agent
  token: ""              # blank -> generated at /config/couchdb/docstore/mcp_token
```

- `!secret <key>` references persist in the stored options and are expanded
  by the Supervisor when the container starts (watch the supervisor log:
  `Request secret couchdb_…`). If a key is missing, the add-on refuses to
  start with the unresolved reference named in the log — it never provisions
  from a literal `!secret` string.
- Generated credentials land under `/config` (on the host:
  `/addon_configs/4e94d283_couchdb/couchdb/`): `users/<name>.password`,
  `docstore/mcp_token`. They are never printed to the add-on log.
- The server administrator bypasses per-database security — treat it as
  break-glass only. Give day-to-day work (Fauxton review, LiveSync clients
  after migration) its own limited user.
- Databases with **no** members remain readable by any authenticated user;
  listing a user as member is what makes a database private.

## Fauxton (management UI)

CouchDB's built-in web UI is at `http://<host>:5984/_utils`. Log in as
`agent` to review and manage the agent databases — a non-admin only sees the
databases it is a member of, and cannot delete databases or edit config.
There is no recycle bin; recovery for deletions is a Home Assistant backup
(the add-on's `/config` data is included).

Plain HTTP: 5984 is exposed as-is for mobile LiveSync. Put a reverse proxy
with TLS in front if you need it reachable from outside the LAN.

## Agent docstore

With `docstore.enabled: true` the add-on serves a stateless JSON-RPC (MCP)
endpoint on internal port **5985**, authenticated by bearer token. Tools:
`doc_get`, `doc_put`, `doc_update`, `doc_delete`, `doc_query` (Mango, capped
at 200), `task_claim`, `task_complete`. Everything is enforced against
`/config/couchdb/docstore/registry.json`:

```json
{
  "databases": ["agent_handoffs", "agent_tasks", "agent_reports", "agent_memory"],
  "types": {
    "handoff": {"db": "agent_handoffs", "id_pattern": "^handoff/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$", "ttl_days": 90},
    "task":    {"db": "agent_tasks", "id_pattern": "^task/[a-z0-9-]+/[a-z0-9-]+$", "ttl_days": 30, "ttl_from": "done"},
    "report":  {"db": "agent_reports", "id_pattern": "^report/[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$", "ttl_days": 180},
    "dossier": {"db": "agent_memory", "id_pattern": "^dossier/[a-z0-9-]+$"},
    "note":    {"db": "agent_memory", "id_pattern": "^note/[a-z0-9/-]+$"}
  }
}
```

Rules enforced in code, not prose:

- Only registry databases are writable/queryable through the tools — the
  vault database cannot be named at all.
- The `_id` namespace prefix **is** the type; it must match the type's
  pattern (a `handoff/...` id can only carry a handoff).
- Writes stamp `type`, `created`/`updated`, `agent`, `session`.
- TTLs: `expires` is stamped per type unless the doc sets it explicitly;
  `"expires": null` opts out. Tasks expire relative to their `done`
  timestamp.
- The sweeper purges expired docs hourly and logs the count.

Edit the registry freely and restart the add-on; it is plain JSON under
`/config`.

## Migrating from obsidian-sync (3.5.2.2)

The slug changed (`obsidian-sync` → `couchdb`), so Supervisor treats this as
a **new add-on**. Data survives via the add-on config directory:

1. Install the `couchdb` add-on. Do **not** start it yet.
2. On the host, move the data into the new config directory:

   ```bash
   mv /addon_configs/4e94d283_obsidian-sync/obsidian-syncserver \
      /addon_configs/4e94d283_couchdb/couchdb
   ```

3. Uninstall `obsidian-sync` (order does not matter, but do it before
   starting couchdb so only one CouchDB holds port 5984).
4. Start `couchdb`. The vault database is picked up unchanged; the previous
   generated admin password (`couchdb/admin_password`) keeps working.
5. Obsidian LiveSync clients need no changes: same port, same database, and
   they authenticate as the administrator, which bypasses the new
   per-database rights. Migrating them to the `vault` user is optional.

## Backups

The add-on stores databases under `/config` (`/addon_configs` on the host),
which Home Assistant backups include. Nothing agent- or vault-related lives
in `/data`, which is wiped on reinstall.
