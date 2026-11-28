# Mealie add-on

[Mealie](https://docs.mealie.io/) is a self-hosted recipe manager and meal
planner. This add-on runs the official image (`ghcr.io/mealie-recipes/mealie`,
pinned release tag) with its data in the add-on's `/data`.

- Web UI and API: `http://<host>:9925` (plain HTTP, container port 9000)
- Data: `/data/mealie` (SQLite database, recipe images, Mealie's own backups)
- No Ingress: Mealie has no sub-path support. Put a TLS reverse proxy in front.

## Reverse proxy

Phones and tablets install Mealie as a web app (Add to Home Screen), which
needs HTTPS. Terminate TLS on a reverse proxy and forward to port 9925:

```nginx
server {
    listen 443 ssl;
    server_name recipes.example.org;

    # Keep in step with the max_upload_size_mb option.
    client_max_body_size 1024m;

    location / {
        proxy_pass http://192.0.2.10:9925;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Then set:

- `base_url` to `https://recipes.example.org`
- `trusted_proxies` to the address the proxy connects from (as seen by the
  add-on host), so Mealie believes its `X-Forwarded-*` headers. Empty trusts no
  proxy; `*` is refused because it lets any client spoof its address.

The mapped port stays reachable on the LAN over plain HTTP. Restrict it with
the host firewall if only the proxy and Home Assistant should reach it.

## First login

With password login on, the first start creates upstream's default admin
`changeme@example.com` with the documented default password (see the
[Mealie docs](https://docs.mealie.io/documentation/getting-started/installation/installation-checklist/)).
Log in, change the email and password immediately, then create the other
users. Self sign-up is always off.

## OIDC

Any OpenID Connect provider works. Example with Gitea:

1. Gitea: Settings -> Applications -> OAuth2 applications -> create one,
   confidential client, redirect URI `https://recipes.example.org/login`.
2. Add-on options:

   ```yaml
   base_url: https://recipes.example.org
   oidc:
     enabled: true
     configuration_url: https://git.example.org/.well-known/openid-configuration
     client_id: <client id from Gitea>
     client_secret: "!secret mealie_oidc_client_secret"
     provider_name: Gitea
   ```

3. Restart, log in with the provider, and check the account works before
   setting `allow_password_login: false`.

Mealie matches existing users by the `email` claim and by default requires
`email_verified: true` from the provider. `user_group` and `admin_group`
compare against the `groups` claim.

The add-on refuses to start when OIDC is enabled with an empty or unresolved
`client_id`, `client_secret`, `configuration_url` or `base_url`, and when both
OIDC and password login are off. The client secret is handed to Mealie as a
file readable only by the Mealie user (`OIDC_CLIENT_SECRET_FILE`), so it stays
out of the add-on log and the container's configured environment.

## AI recipe import

Mealie talks to any OpenAI-compatible API (OpenAI, LiteLLM, Ollama, ...). It is
configured in Mealie itself, not in the add-on: Group settings -> AI. Set a
base URL (e.g. `https://llm.example.org/v1`), an API key and a default model.
A vision-capable model enables imports from photos, an audio model imports
from cooking videos.

With a provider set, a URL import whose page has no structured recipe data is
parsed by the model, and Create -> Import with AI builds a recipe from any mix
of URL, pasted text or HTML and photos.

If the provider resolves to a private address and requests are refused, add
its host to `http_allow_list`.

## Home Assistant

The built-in [Mealie integration](https://www.home-assistant.io/integrations/mealie)
adds meal plan calendars and shopping list to-do entities. Point it at
`http://<host>:9925` with an API token from Mealie's user profile.

## Cooking on a phone or tablet

Open a recipe and enable the screen wake lock switch so the screen stays on
while cooking. Shopping lists and meal plans work from the same web app.

## Database

By default Mealie uses a SQLite file under `/data/mealie`. To use Postgres
instead, create a role and database on the Postgres server and set:

```yaml
postgres:
  enabled: true
  server: db.example.org
  port: 5432
  database: mealie
  user: mealie
  password: "!secret mealie_postgres_password"
```

The connection requires TLS. The password is handed to Mealie as a file
readable only by the Mealie user (`POSTGRES_PASSWORD_FILE`). An empty or
unresolved field stops the add-on.

To move existing data: create a backup in Mealie (Admin -> Backups) while it
still runs on SQLite, enable `postgres` and restart, then restore that backup
in the empty database. The SQLite file stays in `/data/mealie` until you
delete it.

## Backups

`backup: cold`: Home Assistant stops the add-on while it backs up, so the
SQLite file and recipe images are consistent. With `postgres` enabled the
database is not part of that backup: back it up on the Postgres host. Mealie's
own backup archives (`/data/mealie/backups`) are excluded from the Home
Assistant backup.
