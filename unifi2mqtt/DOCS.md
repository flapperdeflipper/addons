# Home Assistant Add-on: Unifi2mqtt

## Prerequisites

This add-on currently requires to have an [MQTT broker](https://www.home-assistant.io/docs/mqtt/broker/) installed, whether it is Mosquitto or the default Home Assistant MQTT broker. Please make sure to install and set up that add-on before continuing.

This addon installs [unifi2mqtt](https://github.com/hobbyquaker/unifi2mqtt).

## Install

Install by going to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/flapperdeflipper/addon-unifi2mqtt`.

## Options

```yaml
mqtt_autoconfig: true
mqtt:
 username: some
 password: pass
 host: a.b.c.d
 port: 1883
 prefix: home/unifi2mqtt

unifi_host: 127.0.0.1
unifi_port: 8443
unifi_user: admin
unifi_pass: somepass
unifi_site: default
insecure: true
verbosity: info
```

These options are available for this addon:

### `unifi_host`

The ip or hostname of the unifi controller.

### `unifi_port`

The listening port of the unifi controller.

### `unifi_user`

The username to use for log-in on the controller.

### `unifi_password`

The password to use for log-in on the controller.

### `unifi_site`

The site to send data for to mqtt.

### `insecure`

Allow a self-signed certificate on the controller.

### `verbosity`

Verbosity of the output. Available options: ("error", "warn", "info", "debug")

