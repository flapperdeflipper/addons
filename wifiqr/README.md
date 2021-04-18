# addon-unifi2mqtt

Home assistant addon for [wifiqr](https://github.com/fliphess/wifiqr)

## Info

|     |     |
| --- | --- |
| Github repository | https://github.com/fliphess/wifiqr |
| PyPi | https://pypi.org/project/flask_wifiqr/ |

## Manual build

```
ARCH=amd64
docker build . \
    --build-arg BUILD_FROM=homeassistant/${ARCH}-base:3.10 \
    --build-arg BUILD_ARCH=${ARCH} \
    --build-arg WIFIQR_VERSION=1.1.0
```
