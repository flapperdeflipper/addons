# Home Assistant Add-on: Mosquitto broker

## Installation

Follow these steps to get the add-on installed on your system:

1. Navigate in your Home Assistant frontend to **Supervisor** -> **Add-on Store**.
2. Find the "Mosquitto broker" add-on and click it.
3. Click on the "INSTALL" button.

## How to use

The add-on has a couple of options available. To get the add-on running:

1. Start the add-on.
2. Have some patience and wait a couple of minutes.
3. Check the add-on log output to see the result.

Create a new user for MQTT via the **Configuration** -> **Users (manage users)**.
Notes:

1. This name cannot be `homeassistant` or `addon`, those are reserved usernames.
2. If you do not see the option to create a new user, ensure that **Advanced Mode** is enabled in your profile.

To use the Mosquitto as a broker, go to the integration page and install the configuration with one click:

1. Navigate in your Home Assistant frontend to **Configuration** -> **Integrations**.
2. MQTT should appear as a discovered integration at the top of the page
3. Select it and check the box to enable MQTT discovery if desired, and hit submit.

If you have old MQTT settings available, remove this old integration and restart Home Assistant to see the new one.

## Configuration

Add-on configuration:

```yaml
anonymous: false
customize:
  active: false
  folder: mosquitto
certfile: fullchain.pem
keyfile: privkey.pem
require_certificate: false

admin_password: "somepassword"
```

### Option: `admin_password`

The password that should be inserted into the database for an admin user.

Default value: `someverysecretthing`

### Option: `anonymous`

Allow anonymous connections. If logins are set, the anonymous user can only read data.

Default value: `false`

#### Option: `customize.active`

If set to `true` additional configuration files will be read, see the next option.

Default value: `false`

#### Option: `customize.folder`

The folder to read the additional configuration files (`*.conf`) from.

### Option: `cafile` (optional)

A file containing a root certificate. Place this file in the Home Assistant `ssl` folder.

### Option: `certfile`

A file containing a certificate, including its chain. Place this file in the Home Assistant `ssl` folder.

### Option: `keyfile`

A file containing the private key. Place this file in the Home Assistant `ssl` folder.

### Option: `require_certificate`

If set to `true` encryption will be enabled using the cert- and keyfile options.

## Mosquitto User management

This add-on is attached to a MySQL database for authentication. For the internal Home Assistant ecosystem, we register `homeassistant` and `addons`, so these may not be used as user names.

New passwords can be created using the `np` utility in the container, or by using the [python libraries](https://github.com/fliphess/mosquitto-auth-plug/tree/master/contrib/python3).

## Disable listening on insecure (1883) ports

Remove the ports from the add-on page network card (set them as blank) to disable them.

### Access Control Lists (ACLs)

It is possible to restrict access to topics based upon the user logged in to Mosquitto. In this scenario, it is recommended to create individual users for each of your clients and create an appropriate ACL.

See the following links for more information:

- [Mosquitto topic restrictions](http://www.steves-internet-guide.com/topic-restriction-mosquitto-configuration/)
- [Mosquitto.conf man page](https://mosquitto.org/man/mosquitto-conf-5.html)

