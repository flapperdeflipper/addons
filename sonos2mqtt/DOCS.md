# Home Assistant Add-on: Sonos2mqtt

## Prerequisites

This add-on currently requires to have an [MQTT broker](https://www.home-assistant.io/docs/mqtt/broker/) installed, whether it is Mosquitto or the default Home Assistant MQTT broker. Please make sure to install and set up that add-on before continuing.

This addon installs [sonos2mqtt](https://github.com/svrooij/sonos2mqtt).

## Install

Install by going to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/fliphess/addon-sonos2mqtt`.


## Options

For more information about configuration options, have a look at the project documentation in https://svrooij.io/sonos2mqtt/getting-started.html

These options are available for this addon:


### Option: `client_id`

Description: The `client_id` used when connecting to MQTT
Type: `String`

Default value: `sonos2mqtt`


### Option: `device`

Description: The IP address or fqdn of one of your sonos speakers.
Type: `String`


### Option: `discovery`

Description: Emit retained auto-discovery messages for each player to mqtt.
Type: `Bool`

Default value: `false`


### Option: `discovery_prefix`

Description: The prefix for the discovery messages.
Type: `String`

Default value: `homeassistant`


### Option: `distinct`

Description: Publish distinct track states
Type: `Bool`

Default value: `true`


### Option: `friendly_names`

Description: Use device name or uuid in topics (except the united topic, always uuid)
Type: `String`

Default value: `name`
Choices: "name", "uuid"


### Option: `listener_ip`

Description: Set the IP of the docker host (so node-sonos-ts knows where the events should be send to)
Type: `String`


### Option: `log_level`

Description: Set the loglevel
Type: `String`

Default value: `information`
Choices: "warning", "information", "debug"


### Option: `prefix`

Description: Instance name. Used as prefix for all topics
Type: `String`

Default value: `home/sonos2mqtt`


### Option: `tts_endpoint`

Description: Default endpoint for text-to-speech
Type: `String`

Default value: ``


### Option: `tts_lang`

Description: Default TTS language
Type: `String`

Default value: `en-US`


