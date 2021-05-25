# Home Assistant Add-on: Json2mqtt

## Prerequisites

This add-on currently requires to have an [MQTT broker](https://www.home-assistant.io/docs/mqtt/broker/) installed, whether it is Mosquitto or the default Home Assistant MQTT broker. Please make sure to install and set up that add-on before continuing.

This addon installs [json2mqtt](https://github.com/hobbyquaker/json2mqtt).

## Install

Install by going to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/flapperdeflipper/addons`.

## Options

```yaml
mqtt_autoconfig: true
mqtt:
 username: some
 password: pass
 host: a.b.c.d
 port: 1883
 prefix: home/json2mqtt
 ssl: false
 ssl_cert: /etc/ssl/cacert.pem

insecure: true
schema_dir: /share/json2mqtt/schemas
verbosity: info
```
