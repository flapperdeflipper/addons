# Configuration

```yaml
repository:
  url: <path to your repository>
  username: user
  password: pass
  pull_before_push: true
  commit_message: 'Home Assistant Git Exporter'
export:
  lovelace: true
  addons: true
  esphome: true
checks:
  enabled: true
  check_for_secrets: true
  check_for_ips: true
exclude:
  - '*.db'
  - '*.log'
  - __pycache__
  - deps/
  - known_devices.yaml
  - tts/
dry_run: false
```

### `repository.url`

Any https url to your git repository. (For now _no_ SSH)

### `repository.email` (Optional)

The email address the commits author is using.

### `repository.username`

Your username for https authentication.

### `repository.password`

Your password or __access token__ for your repository.

### `repository.pull_before_push`

Should the repository be pulled first and commit the new state on top?

### `repository.commit_message`

The commit message for the next commit.


### `export.lovelace`

Enable / Disable the export for the lovelace config.

### `export.addons`

Enable / Disable the export for the supervisor addons config.

### `export.esphome`

Enable / Disable the export for the esphome config.

### `checks.enabled`

Enable / Disable the checks in the exported files.

### `checks.check_for_secrets`

Add your secret values to the check.

### `checks.check_for_ips`

Add pattern for ip and mac addresses to the search.


### `exclude`

The files / folders which should be excluded from the config export.

Following folders and files are excluded from the sync per default:

* `secrets.yaml` (secrets are cleared)
* `.cloud`
* `.storage`

### `dry_run`

Only show the changes and don't commit or push.
