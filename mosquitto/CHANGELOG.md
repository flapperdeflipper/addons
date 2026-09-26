# Changelog
All notable changes to this project will be documented in this file.

## 2026.09.26.1

- **Fixed:** refuse to configure the broker when `admin_password` is still a literal `!secret …` reference (secrets.yaml key missing at container start) instead of using the reference string as the password

## 2026.09.05.1

- **Rebuild for cosign signing** — no functional changes; rebuilt from master after keyless cosign image signing landed in CI, so this tag publishes with a signature.
