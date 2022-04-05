# addon-unifi2mqtt

Home assistant addon for [unifi2mqtt](https://github.com/hobbyquaker/unifi2mqtt)

## Info

|     |     |
| --- | --- |
| Github repository | https://github.com/hobbyquaker/unifi2mqtt |
| Npm | https://www.npmjs.com/package/unifi2mqtt |

## Manual build

```
ARCH=amd64
docker build \
  --build-arg BUILD_ARCH=${ARCH} \
  --build-arg BUILD_FROM=mannkind/unifi2mqtt:v0.8.20061.0158 .
