# addon-json2mqtt

Home assistant addon for [json2mqtt](https://github.com/flapperdeflipper/json2mqtt)

## Info

|     |     |
| --- | --- |
| Github repository | https://github.com/fliphess/json2mqtt |
| PyPi | https://pypi.org/project/json2mqtt |

## Manual build

```
ARCH=amd64
docker build . \
    --build-arg BUILD_FROM=homeassistant/${ARCH}-base:3.10 \
    --build-arg BUILD_ARCH=${ARCH} \
    --build-arg JSON2MQTT_VERSION=0.0.2 ```
