# Home Assistant Add-on: WifiQR

Show a QR code with your WIFI password in home assistant.

It is recognized by both iPhone and Android.
To connect to your wifi, film the QR code with your camera,
and the phone will instantly ask you if you want to join the wifi network.

Show your guests the QR code in the companion app, or through a in-house dashboard to connect to your wifi.


## Prerequisites

This addon installs [WifiQR](https://github.com/fliphess/wifiqr).

## Install

Install by going to Supervisor -> Add-on store -> Add new repository by url and fill in `https://github.com/fliphess/addons`.


## Options

```yaml
wifi_password: "some_password"
wifi_ssid: "some_ssid"
debug: false
```

These options are available for this addon:

### `wifi_password`

The wifi password of the ssid you want to create a QR for

You can use the input fields, or configure `!secret secret_name` from the yaml editor to make use of the secrets defined in `secrets.yaml`.
Make sure you restart home-assistant before retrieving the secrets with this addon.


### `wifi_ssid`

The wifi ssid to put into the QR image

