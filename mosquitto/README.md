# addon-mosquitto

This is a fork of the [home assistant mosquitto](https://github.com/home-assistant/addons/tree/master/mosquitto) addon.

It uses a newer auth plugin and a MySQL backend for authentication instead of the http backend that is used in the core addon.


## Auth plugin

The mosquitto auth plugin by jpmens is deprecated and does not compile for newer mosquitto versions.

Luckily @iegomez stepped in and created this [wonderful new mosquitto auth plugin in golang](https://github.com/iegomez/mosquitto-go-auth).
That repository was archived in 2025; this addon uses the maintained fork [lhns/mosquitto-go-auth](https://github.com/lhns/mosquitto-go-auth), which keeps the same configuration options and password hashes.


## Using other auth backends

As mentioned, you can use all auth backends that are documented in the auth plugin documentation.
It's currently not configurable in this addon yet, but if required those backends can be added.

To use an alternate backend, for now please create a PR implementing this functionality, or add a static configuration file in `/data/mosquitto.conf`, which will override the default `mosquitto.conf`.


## Known issues

When deleting the addon, the database is not removed.


## Build

To manually build, use the following command:

```
ARCH=amd64
docker build . \
  --build-arg BUILD_FROM=homeassistant/${ARCH}-base-debian:bookworm \
  $( yamltojson build.yaml | jq -r '.args | to_entries|map("--build-arg \(.key)=\(.value)")[]' )
```
