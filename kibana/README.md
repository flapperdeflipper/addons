# addon-mosquitto

This is an addon for kibana

It uses the upstream kibana container from elastic


## Build

To manually build, use the following command:

```
docker build . \
  --build-arg BUILD_FROM=homeassistant/amd64-base-debian:bullseye \
  $( yamltojson build.yaml | jq -r '.args | to_entries|map("--build-arg \(.key)=\(.value)")[]' )
```
