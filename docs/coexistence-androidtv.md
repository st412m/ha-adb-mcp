# Coexistence with the androidtv integration

How to run this add-on and Home Assistant's `androidtv` integration against the same device without the two ADB sessions fighting.

## The constraint

Android's `adbd` does not tolerate two independent TCP clients. The `androidtv` integration connects to devices directly by default (python `adb-shell`), so with this add-on also connected, the two sessions fight over the same daemon.

## The fix

This add-on runs a classic adb server (`adb -a`) on port 5037. Point the integration at that server instead of at the device:

1. Map `5037/tcp` in the add-on's network configuration.
2. In the `androidtv` integration, set *ADB server* to the HA host IP and the port to `5037`.

The integration and this MCP server then share one adb daemon and one device session.

## What to expect when switching an existing entry

`adb_server_ip` is not in the integration's options flow, so an existing config entry has to be deleted and re-added. Entity IDs survive as long as the device `unique_id` (its MAC) is unchanged.

## Security

The adb server has no authentication at all. Never expose port 5037 beyond your LAN.
