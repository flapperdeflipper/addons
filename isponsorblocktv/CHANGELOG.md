# Changelog
All notable changes to this project will be documented in this file.

## 2026.11.22.2

- **Changed** — automated dependency update (Renovate).

## 2026.11.22.01

- **Changed** — upstream iSponsorBlockTV pinned to release `v2.11.0` (`ISPONSORBLOCKTV_VERSION` build arg). The build previously cloned whatever was on the default branch.
- **Changed** — base image `3.13-alpine3.21` -> `3.13-alpine3.24`; tempio 2021.09.0 -> 2026.07.0.

## 2026.09.05.01

- **Rebuild for cosign signing** — no functional changes; rebuilt from master after keyless cosign image signing landed in CI, so this tag publishes with a signature.
