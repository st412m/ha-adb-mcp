# ADB MCP Server

An MCP server over Streamable HTTP that lets an assistant operate Android devices on your
network over ADB: shell, screenshots, UI automation, app installation including `.apks`
bundles, file transfer, logcat, and package management with guard rails.

Every device you want to reach needs ADB enabled on it and must be reachable from the Home
Assistant host over the LAN. TV boxes keep ADB over TCP on permanently once it is switched
on in Developer Options. Phones, tablets and watches on Android 11+ use Wireless Debugging,
whose ports are random and change on every reboot.

## Setup

**1. Configure the add-on.** Set a long random `token`; leave `allow_shell` and
`allow_uninstall` as they are for now. Leave `devices` empty on the first run.

**2. Start the add-on.** The log opens with the toolchain banner and the build manifest. If
`devices` is set, each entry is connected at startup.

**3. Connect the first device.**

- TV boxes and anything with ADB over TCP always on: call `adb_connect` with `ip` or
  `ip:port` (port 5555 is implied), then accept the **Allow USB debugging?** dialog on the
  device screen and tick *Always allow*.
- Android 11+ phones, tablets and watches: open Wireless Debugging, choose *Pair device with
  pairing code*, call `adb_pair` with the `ip:port` and the 6-digit code from that dialog
  while it is still open, then `adb_connect` with the `ip:port` from the **main** Wireless
  Debugging screen. The two ports are different and both are random.

**4. Confirm.** `adb_devices` lists what is connected, with serial and state. A device in
`offline` or `unauthorized` state has not finished step 3.

**5. Add the stable devices to `devices`** so they reconnect at startup. Do not list Android
11+ wireless-debugging devices: their port changes on every reboot, so a fixed entry goes
stale by itself.

ADB RSA keys live in `/data/.android`, so pairing and authorisation survive add-on restarts
and updates.

## Configuration

| Option | Default | What it does |
|---|---|---|
| `token` | `changeme` | Secret in the URL path. The endpoint is `http://<host>:3200/private_<token>/mcp`. Change it. |
| `devices` | `[]` | Devices connected at startup, `ip` or `ip:port` (port defaults to 5555). |
| `allow_shell` | `true` | Exposes `adb_shell`. Turning it off blocks only that tool; the internal shell paths other tools rely on keep working. |
| `allow_uninstall` | `false` | `true` unlocks `adb_app mode=uninstall`. Leave it off unless you are actually removing packages — `mode=disable` is reversible. |
| `log_requests` | `false` | Logs every proxied request and every tool call: name, arguments, duration, response size or error. |

Port `3200` is the auth proxy and the only port you connect to. Port `5037` is the adb server
itself, published to the LAN only if you map it, so the Home Assistant `androidtv` integration
can share one session with this add-on.

With `log_requests: true`, `adb_text.text` and `adb_pair.code` are masked in the log and in
error text. **`adb_shell.command` is never masked** — it is an arbitrary administrator command
with no fixed shape. Type secrets through `adb_text`, not through `input text "..."` run via
`adb_shell`.

Full notes on every option, including what stays available with `allow_shell: false`:
[docs/configuration.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/configuration.md).

## Connecting claude.ai

Expose port 3200 through a reverse proxy that terminates TLS (Caddy, nginx, Cloudflare
Tunnel), then add a custom connector pointing at:

```
https://your-domain/private_<token>/mcp
```

The token in the path is the only authentication layer.

## Tools

18 tools.

**Session**

- `adb_devices` — list connected devices with serial, state and description
- `adb_connect` — connect a network device, `ip` or `ip:port`
- `adb_disconnect` — drop one host, or every transport
- `adb_pair` — pair an Android 11+ device over Wireless Debugging

**Shell and logs**

- `adb_shell` — run any shell command, return stdout
- `adb_logcat` — non-blocking log dump, filterspec or substring, filtered on-device

**Screen and input**

- `adb_screenshot` — JPEG screenshot plus a line giving the screen size, image size and scale
- `adb_ui_dump` — compact UI hierarchy with tap coordinates
- `adb_tap` — tap a coordinate, optionally in screenshot coordinates, with optional `verify`
- `adb_swipe` — swipe between two points; same point plus a long duration is a long-press
- `adb_key` — send a keyevent by name or numeric code
- `adb_text` — type into the focused field; non-ASCII goes through ADBKeyBoard
- `adb_find_and_tap` — find an element by label and activate it, tapping or walking the focus

**Apps and files**

- `adb_install` — install one `.apk`, a split set, or one `.apks`/`.xapk`/`.apkm` bundle
- `adb_uninstall` — uninstall by package name
- `adb_app` — package operations with guard rails: list, launch, stop, clear, disable, uninstall, back up, restore
- `adb_push` — copy a file from `/media` or `/share` to the device
- `adb_pull` — copy a file from the device to `/media` or `/share`

Arguments, refusal rules, per-tool timeouts and the `.apks` bundle, screenshot-geometry and
`verify` semantics:
[docs/tools.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/tools.md).

## Guard rails

These apply to `adb_app` and are the only things that refuse a call outright.

- **`dry_run: true` is the default for everything that changes state.** The plan names the
  rollback path per package. Set `dry_run=false` to apply. `stop` is the exception and acts
  immediately.
- **The protected set is derived from the device, never hardcoded.** Launcher, active IME,
  package installer, WebView provider, role holders, account packages, and system packages
  holding a listening socket. Any overlap aborts the whole call. No flag lifts it.
- **The network guard refuses `disable`, `uninstall`, `stop` and `clear`** while the package
  holds a listening TCP socket *and* something outside the device is connected to that port
  right now. The refusal names the port and the peer. Only `force_network: true` lifts it,
  and it does not lift the protected set.
- **`mode=uninstall` needs three things:** the `allow_uninstall` option on, an explicit `mode`
  in the call, and a successful APK backup. `force: true` overrides a failed backup and
  nothing else — it is a different flag from `force_network`.
- **An account canary runs between batches.** A drop in the account count rolls that batch
  back and stops. Everything applied is written to a snapshot under `store`, so
  `action=restore` undoes it in one call.

Every plan and every report carries a `network_guard` object whose `status` is `not_serving`
(nothing found), `overridden` (`force_network=true` lifted a hit) or `blind` (`/proc/net`
could not be read, so the action ran without the check).

## Troubleshooting

**A device shows as `offline` or `unauthorized`.** Accept the debugging dialog on the device
screen, then reconnect:

```
adb_disconnect host=192.168.1.50
adb_connect host=192.168.1.50
```

**A phone or watch stopped connecting.** Its Wireless Debugging port changed after a reboot.
Read the new one off the device and `adb_connect` again — re-pairing is not needed.

**An install fails with `INSTALL_FAILED_VERIFICATION_FAILURE`.** The on-device verifier is
rejecting ADB installs:

```
adb_shell command="settings put global verifier_verify_adb_installs 0"
```

**New tools or changed parameters are not visible.** MCP clients cache `tools/list` per
conversation. Start a new conversation after updating the add-on.

More symptoms:
[docs/troubleshooting.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/troubleshooting.md).

## Security

- ADB is not a sandbox. `adb_uninstall` removes app data, and disabling system packages can
  leave a device unbootable. Keep a way to recover each device.
- The token sits in the URL path. Use a long random value and never expose port 3200 to the
  internet without TLS in front of it.
- `adb_shell` is full device shell access. Set `allow_shell: false` if you only need
  screenshots and UI control.
- `adb_push`, `adb_pull` and `adb_install` reach only `/media` and `/share` on the Home
  Assistant side; anything outside is refused.
- `adb_app` writes APK backups and its rollback snapshot under `store`, default
  `/media/adb-mcp`. Those APKs are readable by anything else with access to `/media`.
- Never expose port 5037 beyond your LAN. The adb server has no authentication at all.
- Account names are never returned by any tool — the canary reads counts and types only.

## Where the rest is

- [docs/tools.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/tools.md) — full tool semantics, guard rails, refusal rules, timeouts
- [docs/configuration.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/configuration.md) — every option in detail, ports
- [docs/troubleshooting.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/troubleshooting.md) — symptoms and the command for each
- [docs/coexistence-androidtv.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/coexistence-androidtv.md) — sharing one adb session with the `androidtv` integration
- [docs/internals.md](https://github.com/st412m/ha-adb-mcp/blob/main/docs/internals.md) — module layout, how a tool is registered, build-time traps
- [CHANGELOG.md](https://github.com/st412m/ha-adb-mcp/blob/main/adb_mcp/CHANGELOG.md) — version history
- [github.com/st412m/ha-adb-mcp](https://github.com/st412m/ha-adb-mcp) — the repository
