# addons

My personal home-assistant addons

## Install

Install by going to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/flapperdeflipper/addons`.


## Verifying images

Images pushed from `master` are signed with [cosign](https://github.com/sigstore/cosign) keyless, via the build workflow's GitHub OIDC identity. Verify any published tag with:

```console
cosign verify \
  --certificate-identity-regexp '^https://github\.com/flapperdeflipper/addons/\.github/workflows/builder\.yml@refs/heads/master$' \
  --certificate-oidc-issuer-regexp '^https://token\.actions\.githubusercontent\.com$' \
  flapperdeflipper/addon-ha-opencode:2.9.0
```

Swap the image reference for any `flapperdeflipper/addon-*` repository and tag.

**Note:** tags published before cosign was enabled are unsigned; only tags built after the signing workflow landed verify successfully.


## Disclaimer

Most of these addons are either for personal use and as a result not thoroughly tested, others are a direct fork from the community or core addons. You are recommended not to use any of those addons but instead use the original.
