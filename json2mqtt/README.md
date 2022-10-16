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
  $( yamltojson build.yaml | jq -r '.args | to_entries|map("--build-arg \(.key)=\(.value)")[]' )
```
