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
| `master_key` | Auto-generated master key (when the `master_key` option is empty), mode 600. |
| `config.yaml.bak.<timestamp>` | Backups made by `reset_config`. |

To regenerate `config.yaml` from the starter template: set the `reset_config`
option to `true` and restart the add-on. The existing file is kept as a
timestamped `.bak` - nothing is ever deleted. Set `reset_config` back to
`false` afterwards.

### API keys

Provider keys are not stored in `config.yaml`. Add them as entries in the
`env_vars` add-on option, e.g.:

| Name | Value |
|------|-------|
| `DEEPSEEK_API_KEY` | *(your DeepSeek key)* |
| `ZAI_API_KEY` | *(your Z.ai key)* |

They are injected as environment variables on every start and referenced from
the config as `os.environ/DEEPSEEK_API_KEY`, `os.environ/ZAI_API_KEY`, etc.
(You can of course also hardcode keys in `config.yaml` - your file, your
choice - but keeping them in options means HA stores them as passwords.)

### The master key

Clients authenticate against the proxy with the master key (or virtual keys,
if you later enable the database).

- If the `master_key` option is set, that value is used.
- If left empty, a key is generated once and persisted at
  `/data/litellm/master_key`. Show it with:
  `cat /data/litellm/master_key` in the add-on terminal.

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

The `litellm-database` image supports the LiteLLM admin UI, per-key budgets
and usage tracking, but only with a PostgreSQL database. To enable:

1. Run a Postgres server (e.g. the community PostgreSQL add-on)
2. Add `DATABASE_URL` = `postgresql://user:pass@host:5432/litellm` to the
   add-on `env_vars`
3. Uncomment `database_url: os.environ/DATABASE_URL` in
   `/data/litellm/config.yaml` and restart

## Updating

Bump the `FROM` tag in `Dockerfile` and `version:` in `config.yaml` together
(`v1.99.1` currently; check
<https://github.com/BerriAI/litellm/releases>). The config in `/data` is never
touched by updates.
