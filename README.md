# addons

My personal home-assistant addons

[AI Usage Proxy](ai_usage_proxy/README.md) publishes Claude, OpenAI/Codex, and z.ai subscription usage to MQTT displays and provides account management through Home Assistant Ingress.

## Install

[![Add repository to My Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https://github.com/flapperdeflipper/addons)

Or manually: go to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/flapperdeflipper/addons`.


## Verifying images

Images pushed from `main` are signed with [cosign](https://github.com/sigstore/cosign) keyless, via the build workflow's GitHub OIDC identity. Verify any published tag with:

```console
cosign verify \
  --certificate-identity-regexp '^https://github\.com/flapperdeflipper/addons/\.github/workflows/builder\.yml@refs/heads/main$' \
  --certificate-oidc-issuer-regexp '^https://token\.actions\.githubusercontent\.com$' \
  flapperdeflipper/addon-ha-opencode:2.9.0
```

Swap the image reference for any `flapperdeflipper/addon-*` repository and tag.

**Note:** tags published before cosign was enabled are unsigned; only tags built after the signing workflow landed verify successfully.


## Disclaimer

Most of these addons are either for personal use and as a result not thoroughly tested, others are a direct fork from the community or core addons. You are recommended not to use any of those addons but instead use the original.
