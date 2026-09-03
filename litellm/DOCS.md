# LiteLLM Proxy add-on

[LiteLLM](https://docs.litellm.ai/docs/proxy/quick_start) proxy server for
Home Assistant: an OpenAI-compatible gateway that routes Assist (and anything
else speaking the OpenAI API) to DeepSeek, Z.ai and 100+ other LLM providers.

- Image: `ghcr.io/berriai/litellm-database:v1.99.1` (pinned semver; the rolling
  `main-stable` tag is deprecated)
- Endpoint: `http://litellm:4000/v1` from Home Assistant and other add-ons,
  `http://<host>:4000/v1` from the LAN
- Config file: **yours to edit, never overwritten** - see below

## Configuration that survives restarts

Everything persistent lives under `/data/litellm/`:

| File | Purpose |
|------|---------|
| `config.yaml` | The LiteLLM proxy config. Generated once on first boot, then **left untouched forever**. Edit it freely (add-on terminal, SSH, File editor, opencode); restarts and rebuilds keep it. |
| `master_key` | Fallback master key, auto-generated only when the `master_key` option (a secrets.yaml key name) is empty or unresolvable. Mode 600. |
| `config.yaml.bak.<timestamp>` | Backups made by `reset_config`. |

To regenerate `config.yaml` from the starter template: set the `reset_config`
option to `true` and restart the add-on. The existing file is kept as a
timestamped `.bak` - nothing is ever deleted. Set `reset_config` back to
`false` afterwards.

### API keys & secrets

**No secret values are stored in this add-on's options or files.** Options
hold only *key names* into `/homeassistant/secrets.yaml` (the HA config
directory is mapped read-only into the add-on), and `run.sh` resolves them at
every start. Home Assistant add-on options cannot use `!secret` (the
Supervisor resolves options to plain JSON), so the add-on does the equivalent
itself.

Example `env_vars` option entries:

| Name (env var) | secret (secrets.yaml key) |
|----------------|---------------------------|
| `DATABASE_URL` | `litellm_database_dsn` |
| `DEEPSEEK_API_KEY` | `deepseek_api_token` |
| `ZAI_API_KEY` | `z_ai_api_token` |
| `OPENAI_API_KEY` | `openai_api_token` |
| `LITELLM_SALT_KEY` | `litellm_salt_key` |

They are injected as environment variables on every start and referenced
from the LiteLLM config as `os.environ/<NAME>`. Literal
`{ name: ..., value: password }` entries still work, but prefer secret
references. Unresolvable keys are skipped with a warning in the log (names
only - values are never logged).

The master key works the same way: set the `master_key` option to a
secrets.yaml key name (e.g. `litellm_master_key`). If the option is empty or
unresolvable, a key is generated once and persisted at
`/data/litellm/master_key` as a fallback.

## Starter config

First boot writes a working config with:

- `deepseek-chat`, `deepseek-reasoner` (via `DEEPSEEK_API_KEY`)
- `glm-4.7` (via `ZAI_API_KEY`)
- Commented examples for OpenAI, Anthropic and Ollama
- `drop_params: true` and `master_key: os.environ/LITELLM_MASTER_KEY`

## Test it

From the add-on terminal (or any LAN host against port 4000):

```bash
curl -s http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $(cat /data/litellm/master_key)" \
  -H "Content-Type: application/json" \
  -d '{"model": "deepseek-chat", "messages": [{"role": "user", "content": "hello"}]}'
```

`GET /health/liveliness` is used as the container health check;
`GET /v1/models` lists configured models.

## Wiring into Assist

> The **core OpenAI integration no longer accepts third-party OpenAI-compatible
> endpoints** (Home Assistant 2026.8+ docs: "does not support
> OpenAI-API-compatible third-party services, proxies, or alternative
> backends"). Use a client that lets you set a custom base URL instead.

Recommended on this installation: **Extended OpenAI Conversation** (HACS
custom integration, `extended_openai_conversation`):

1. Install it via HACS
2. Add the integration, base URL `http://litellm:4000/v1`,
   API key = the LiteLLM master key
3. Pick a model (e.g. `deepseek-chat` or `glm-4.7`), set it as the preferred
   conversation processor in Assist settings

Any other OpenAI-compatible client works the same way, including custom
integrations of your own.

## Optional: admin UI, virtual keys, spend tracking

The `litellm-database` image supports the LiteLLM admin UI, virtual keys,
budgets and spend tracking, but only with a PostgreSQL database (LiteLLM's
Prisma layer does not support MariaDB/MySQL). Postgres does **not** need to
run on the HA host - a server elsewhere on the network works fine.

### 1. Prepare PostgreSQL (on the Postgres server)

```sql
CREATE DATABASE litellm;
CREATE USER litellm WITH PASSWORD '<choose-a-password>';
ALTER DATABASE litellm OWNER TO litellm;
```

Ownership rather than GRANTs, because PostgreSQL 15+ restricts creating
objects in the default `public` schema. Also make sure the server accepts
connections from the HA host: `listen_addresses`, a `pg_hba.conf` entry for
the HA machine, and port 5432 reachable.

### 2. Point the add-on at it

- Add-on **Configuration → env_vars**: name `DATABASE_URL`,
  secret = your DSN key in secrets.yaml (e.g. `litellm_database_dsn`,
  value `postgresql://litellm:<password>@<postgres-host>:5432/litellm` -
  percent-encode special characters in the password, e.g. `@` → `%40`)
- That's it: LiteLLM reads the `DATABASE_URL` environment variable directly.
  No line in `/data/litellm/config.yaml` needs to be uncommented (the
  explicit `database_url: os.environ/DATABASE_URL` line is optional).
- Restart. LiteLLM creates its schema automatically on startup - no manual
  migrations.

### 3. Use it

- Admin UI: `http://<ha-host>:4000/ui` - log in as user `admin` with the
  master key as the password. Create virtual keys, set budgets, view spend.
- Optional: add `STORE_MODEL_IN_DB` = `True` to `env_vars` to manage models
  from the UI (DB models are served alongside the YAML `model_list`).

The LiteLLM database lives outside this machine - back it up on the Postgres
server (e.g. `pg_dump litellm`).

## Updating

Bump the `FROM` tag in `Dockerfile` and `version:` in `config.yaml` together
(`v1.99.1` currently; check
<https://github.com/BerriAI/litellm/releases>). The config in `/data` is never
touched by updates.
