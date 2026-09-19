# Changelog
All notable changes to this project will be documented in this file.

## 2026.09.19

- **CalVer versioning** — the add-on version no longer mirrors the Playwright image version; it is now CalVer (`YYYY.MM.DD`). The mirroring rule already broke once (the 1.62.3 release shipped image v1.63.0-noble without bumping the version field). The bundled Playwright version now lives only in the Dockerfile `FROM` line and this changelog. Image stays v1.63.0-noble; no functional changes.

## 1.62.3

- **Playwright 1.63.0** — base image bumped from v1.62.1-noble to v1.63.0-noble (Dependabot).

## 1.62.2

- **Semver-clean republish of the cosign rebuild** — `1.62.1-1` is a semver *prerelease* of `1.62.1` and sorts *lower* than the installed release, so Home Assistant's update entity (AwesomeVersion compare) could never offer it as an update and `auto_update` skipped it too. Same cosign-signed build as `1.62.1-1`, published under a version that sorts correctly. No functional changes.

## 1.62.1-1

- **Rebuild for cosign signing** — no functional changes; rebuilt from master after keyless cosign image signing landed in CI, so this tag publishes with a signature.
