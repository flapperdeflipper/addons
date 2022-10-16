# addon-sonos2mqtt

Home assistant addon for [sonos2mqtt](https://svrooij.io/sonos2mqtt/)

## Info

|     |     |
| --- | --- |
| Documentation | https://svrooij.io/sonos2mqtt |
| Github repository | https://github.com/svrooij/sonos2mqtt |
| Npm | https://www.npmjs.com/package/sonos2mqtt |

## Manual build

```
ARCH=amd64
docker build . \
  --build-arg BUILD_ARCH=${ARCH} \
  --build-arg BUILD_FROM=homeassistant/${ARCH}-base:3.16 \
  $( yamltojson build.yaml | jq -r '.args | to_entries|map("--build-arg \(.key)=\(.value)")[]' )
```
