# Troubleshooting

Symptoms you can hit while running the add-on, and the command that resolves each one.

## `INSTALL_FAILED_VERIFICATION_FAILURE`

The on-device package verifier is rejecting ADB installs. It is a separate switch from `package_verifier_enable`, and its default (unset) means enabled:

```
adb_shell settings put global verifier_verify_adb_installs 0
```

Devices without Play Protect never hit this regardless of the setting, because there is no verifier agent to consult.

## `device offline` / `device not found`

The TCP session died, usually because the device slept or rebooted. `adb_disconnect` that host, then `adb_connect` again.

For Android 11+ wireless debugging, the connect port changes after every reboot, so reconnect with the port currently shown on the Wireless debugging screen. Re-pairing is not needed — the RSA key persists.

## An app looks dead right after installing it

After a replace, dexopt runs before the first launch, so the process can take noticeably longer than usual to appear. Check logcat for an actual `FATAL` before concluding it crashed:

```
adb_logcat filter="FATAL" lines=100
```

`VerityUtils: Failed to measure fs-verity` in the log after a sideload is normal, not an error.

## `adb_find_and_tap` says the element is not found, but it is on screen

Read the `Visible now:` list in the error — it is built from the same nodes the search used, so it shows exactly what the tool could see.

An element drawn as an image with no label of any kind is invisible to `uiautomator`; use `adb_ui_dump` and `adb_tap`/`adb_key` directly. A dump taken while the screen is still animating can also miss it: the add-on retries a stale dump once, but a slow transition may need a second call.

## `uiautomator: ERROR: null root node returned by UiTestAutomationBridge`

The accessibility bridge lost the window, typically right as the screen changes, and also on a device whose screen is off. Retry the call; it is not a persistent fault.

With `verify="ui"` this never fails the action itself — the result carries `ui: unknown (uiautomator: ...)` beside a normal success line.

## The screenshot is black

A near-uniformly dark frame comes back as a warning after the image, not a refusal. Read the warning: it names `mWakefulness` and, where it can be read, whether the focused window carries `FLAG_SECURE`.

```
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Asleep
```

`screen: Asleep` means the device is asleep — `adb_key WAKEUP` first. `FLAG_SECURE` means the system is hiding the content and no screenshot will show it.

An empty capture fails instead, with `screencap produced no data (device asleep or protected content?)`.

## `coords="screenshot"` is refused

```
the screenshot is stale or was never taken - call adb_screenshot. Pass serial the same way as in adb_screenshot: a screenshot without serial and a tap with serial are different keys.
```

Either the screenshot is older than 120 s, or `serial` was passed to one call and omitted in the other. Take a fresh screenshot and pass `serial` identically in both.

## `Access denied (host path outside /media, /share)`

`adb_push`, `adb_pull`, `adb_install` and the `adb_app` store are restricted to `/media` and `/share` on the HA side. Move the file there, or point `store` at a path under one of them.

## A tool the assistant knows about no longer matches the server

The tool list is cached per chat. After updating the add-on, an already-open chat keeps the old tool schemas. Start a new chat.

## A `dry_run` looks right but the real call is refused

Read the refusal text. Both guards name what stopped the call: the protected set lists the packages it matched and the sources they came from, the network guard names the port and the peer.

```
adb_app action=protected
```

shows the whole derived set and the `notes` for any source that could not be read.

## The connector times out on a long call

The reverse proxy gives up before the add-on does on transfers and installs. Background long shell work on the device and poll for it, rather than blocking a single call.
