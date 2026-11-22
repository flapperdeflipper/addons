# Changelog
All notable changes to this project will be documented in this file.

## 2026.11.22.1

- **Changed:** Mosquitto 2.0.22 -> 2.1.4. Websockets now use Mosquitto's built-in implementation; libwebsockets is no longer built.
- **Changed:** auth plugin switched from the archived `iegomez/mosquitto-go-auth` 3.0.0 to the maintained fork `lhns/mosquitto-go-auth` 3.6.0. Database schema, queries and stored password hashes are unchanged.
- **Security:** the 3.6.0 plugin fixes 14 advisories, among them PBKDF2 hashes that accepted any password when malformed.
- **Changed:** an ACL rule starting with `#` or `+` no longer matches `$SYS/...` topics (MQTT spec). Superusers are not affected.
- **Changed:** client ids containing `/`, `+` or `#` are rejected at the ACL check (Mosquitto 2.1).
- **Changed:** `max_packet_size` is set to 16 MiB. Mosquitto 2.1 lowered its default from 256 MiB to 2 MB; zigbee2mqtt's retained `bridge/devices` already reaches ~280 KB.
- **Changed:** `allow_duplicate_messages false` keeps the 2.0 behaviour of one delivery per message for clients with overlapping subscriptions.
- **Changed:** the add-on no longer rewrites passwords on start. `admin_password` and the generated homeassistant/addons passwords only seed the database on first install; after that the MySQL `users` table is the source of truth and changes apply to the next login without a restart. `system_user.json` no longer stores the admin password.
- **Changed:** `max_queued_messages` is 1000 (Mosquitto's default) instead of unlimited, so an offline client with a persistent session can't grow the database without bound.
- **Fixed:** the config is rendered from a template on every start; a restart no longer appends the TLS listeners a second time or keeps stale MySQL credentials.
- **Changed:** start-up waits up to 60s for MySQL, passes MySQL credentials through a temporary defaults file instead of the command line, and writes `system_user.json` and `mosquitto.conf` with mode 0600.

## 2026.11.12.1

- **Changed** — automated dependency update (Renovate).

## 2026.10.25.1

- **Changed** — automated dependency update (Renovate).

## 2026.10.10.1

- **Changed** — automated dependency update (Renovate).

## 2026.09.26.3

- **Changed** — automated dependency update (Renovate).

## 2026.09.26.2

- **Changed** — automated dependency update (Renovate).

## 2026.09.26.1

- **Fixed:** refuse to configure the broker when `admin_password` is still a literal `!secret …` reference (secrets.yaml key missing at container start) instead of using the reference string as the password

## 2026.09.05.1

- **Rebuild for cosign signing** — no functional changes; rebuilt from master after keyless cosign image signing landed in CI, so this tag publishes with a signature.
