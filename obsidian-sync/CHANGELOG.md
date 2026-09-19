# Changelog

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
