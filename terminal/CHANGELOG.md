# Changelog
All notable changes to this project will be documented in this file.

## 1.0.0

- **Initial release** — ingress-only bash terminal built on the OpenCode add-on image, inheriting its full toolchain (node 24, gh/glab, jq, yq, tmux, ttyd, openssh-client, chromium, hab, zigporter, 1Password CLI, opencode runtime).
- **Dotfiles and toolset sync** — both repositories are cloned or pulled into `/data` at every start and the dotfiles profile is stowed into the `/data` home, giving the same shell environment as a workstation bootstrap; `dotfiles-sync` re-runs it interactively.
- **Workstation package set** — the merged `.packages` + `config/packages` lists from the dotfiles and toolset repositories (vim, neovim, stow, fzf, bat, shellcheck, and ~70 more), every name verified against Debian trixie.
- **Python dependencies** — `/data/.venv` is created and the dotfiles `pyproject.toml` installed (ansible, esphome, ipython, kubernetes, ...), detached to the background on first start so the terminal is available immediately.
- **GitHub authentication** — the private dotfiles repository clones over HTTPS via `gh` credentials: either a `GH_TOKEN` in the env_vars option or a one-time interactive `gh auth login` in the terminal.
- **Ingress only** — no SSH server and no exposed ports; the terminal is reachable exclusively through Home Assistant, with the same ttyd clipboard/touch-scroll page and theming options as the OpenCode terminal.
