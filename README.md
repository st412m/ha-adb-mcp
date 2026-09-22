# ADB MCP Server — Home Assistant App (Add-on)

MCP (Model Context Protocol) server for controlling Android devices over **network ADB**, packaged as a Home Assistant app. It lets AI assistants — claude.ai custom connectors, Claude Desktop and other MCP clients — see and control Android TVs, Fire TVs, phones, tablets and watches on your LAN: run shell commands, take screenshots, inspect and tap the UI, type text including Unicode, install apps, transfer files and read logcat.

Transport is MCP Streamable HTTP (`POST /mcp`, plain JSON responses, immune to SSE buffering in CDNs and tunnels). Authentication is a secret path prefix, `/private_<token>`, the same pattern as [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp).

Home Assistant ships its own MCP Server integration, which does a different job: it exposes the HA conversation agent and the intents an assistant already understands. It gives no shell, no screen and no package manager. This app works below the level where entities exist and talks to Android over ADB directly. If what you want is an entity, use the official integration; if what you want is a terminal and a screen, use this.

## Requirements

| Requirement | Detail |
|---|---|
| Home Assistant | a Supervisor-managed install (HAOS or Supervised) |
| Architectures | `amd64`, `aarch64` |
| Device side | Android with ADB over the network reachable from the HA host |
| Ports | `3200/tcp` for the MCP endpoint; `5037/tcp` optional, for sharing the adb daemon |

## Installation

Home Assistant renamed **add-ons** to **apps**; on an older core the two menus below are called *Add-ons* and *Add-on Store*.

**1. Add this repository**

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fha-adb-mcp)

By hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste `https://github.com/st412m/ha-adb-mcp`, select **Add**. If the badge opens the App Store without a dialog, use the manual path ([my.home-assistant.io#698](https://github.com/home-assistant/my.home-assistant.io/issues/698)).

**2. Install and configure**

In the **ADB MCP Server** card: **Install**, set a long random `token` in Configuration, then **Start**.

**3. Enable ADB on the devices**

- Fire TV / Android TV: Settings → Developer Options → ADB Debugging → ON. Network ADB listens on port 5555.
- Phones and tablets on Android 10 or older: enable USB debugging, connect over USB once, run `adb tcpip 5555`. This resets on reboot.
- Phones and tablets on Android 11+: Wireless debugging → "Pair device with pairing code" → call `adb_pair` with the shown `ip:port` and 6-digit code, keeping the dialog open → `adb_connect` to the `ip:port` from the **main** Wireless debugging screen.

**4. Auto-connect stable devices at startup**

```yaml
token: "your-long-random-token"
devices:
  - "192.168.1.50"        # port 5555 implied
  - "192.168.1.51:5555"
allow_shell: true
allow_uninstall: false
log_requests: false
```

**5. Accept the debugging prompt**

On first connection, accept the **"Allow USB debugging?"** dialog on each device and check "Always allow". ADB keys persist in `/data/.android` across app restarts and updates.

## Configuration

| Option | Default | Description |
|---|---|---|
| `token` | `changeme` | Secret path token. **Change it.** |
| `devices` | `[]` | `ip` or `ip:port` entries auto-connected at startup |
| `allow_shell` | `true` | `false` disables the raw `adb_shell` tool; internal plumbing keeps working |
| `allow_uninstall` | `false` | `true` unlocks `adb_app mode=uninstall` |
| `log_requests` | `false` | HTTP access log in the proxy and a per-tool-call log in the server |

Longer notes, including what stays available with `allow_shell: false` and how arguments are masked in the log, are in [docs/configuration.md](docs/configuration.md).

## Connecting claude.ai

Expose port 3200 through a reverse proxy (Caddy, nginx, Cloudflare Tunnel), then add a custom connector pointing at:

```
https://your-domain/private_<token>/mcp
```

## Tools

18 tools. Full semantics, guard rails, refusal rules and per-tool timeouts are in [docs/tools.md](docs/tools.md).

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

## Limitations

- The tool list is cached per chat. After updating the app, an already-open chat keeps the old tool schemas; start a new chat to see changed tools or parameters.
- A gateway timeout of roughly 60 s applies per tool call. Long-running shell commands are cut off by the connector, not by the app. Background them on-device and poll.
- `aarch64` is build-verified, not device-verified: the image builds and starts and the screenshot smokes pass, but the ADB tools themselves have not been exercised on that architecture.
- Screenshots wake devices. `screencap` on a sleeping Android TV wakes it, and HDMI-CEC will switch on the attached television.
- One ADB session per device. Android's `adbd` does not tolerate two independent TCP clients; to run the `androidtv` integration alongside this app, route it through this app's adb server — see [docs/coexistence-androidtv.md](docs/coexistence-androidtv.md).

## Troubleshooting

`INSTALL_FAILED_VERIFICATION_FAILURE` — the on-device verifier rejects ADB installs:

```
adb_shell settings put global verifier_verify_adb_installs 0
```

`device offline` / `device not found` — the TCP session died: `adb_disconnect` that host, then `adb_connect` again. On Android 11+ wireless debugging the port changes after every reboot.

A black screenshot — read the warning under the image. `screen: Asleep` means the device is asleep, so `adb_key WAKEUP` first; `FLAG_SECURE` means the system is hiding the content.

Everything else is in [docs/troubleshooting.md](docs/troubleshooting.md).

## Security

- ADB is not a sandbox. `adb_uninstall` removes app data, and disabling system packages can leave a device unbootable. Start with `allow_shell: false`, and keep a way to recover each device.
- The token in the URL path is the only auth layer. Use a long random value and serve it over HTTPS.
- `adb_shell` is full device shell access. Disable it if you only need screenshots and UI control.
- `adb_push`, `adb_pull` and `adb_install` are restricted to `/media` and `/share` on the HA side.
- `adb_app` writes APK backups and its rollback snapshot under `store`, default `/media/adb-mcp`. Those APKs are readable by anything else with access to `/media`.
- Never expose port 5037 beyond your LAN — the adb server has no auth at all.
- With `log_requests: true`, `adb_text` input and `adb_pair` codes are masked in the log and in error text; `adb_shell.command` is not, since it has no fixed shape to mask. Type secrets through `adb_text`.

## Links

- [docs/](docs/) — [tools](docs/tools.md), [configuration](docs/configuration.md), [troubleshooting](docs/troubleshooting.md), [coexistence with androidtv](docs/coexistence-androidtv.md), [internals](docs/internals.md)
- [Changelog](adb_mcp/CHANGELOG.md)
- [License](LICENSE) — MIT
