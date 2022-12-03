# addon-mosquitto

This is an addon for kibana

It uses the upstream kibana container from elastic


## Build

To manually build, use the following command:

```
docker build . \
  --build-arg BUILD_FROM=docker.elastic.co/kibana/kibana:8.5.2 \
  $( yamltojson build.yaml | jq -r '.args | to_entries|map("--build-arg \(.key)=\(.value)")[]' )
```
