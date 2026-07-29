# ADB MCP Server — Home Assistant App (Add-on)

MCP (Model Context Protocol) server for controlling Android devices over **network ADB**, packaged as a Home Assistant app. Lets AI assistants (claude.ai custom connectors, Claude Desktop, etc.) see and control Android TVs, Fire TVs, phones, tablets and watches on your LAN: run shell commands, take screenshots, inspect and tap UI, type text (incl. Unicode), install apps, transfer files, read logcat.

Transport: MCP Streamable HTTP (`POST /mcp`, plain JSON responses — immune to SSE buffering in CDNs/tunnels). Auth: secret path prefix `/private_<token>`, same pattern as [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp).

**Platforms:** built for `amd64` and `aarch64`. Developed and battle-tested on amd64 (HAOS). aarch64 has been confirmed by an external tester on a Raspberry Pi 4 (HAOS bare metal): clean build, clean start, all screenshot-pipeline smokes pass — though the ADB tools themselves were not exercised there (no Android device on that setup). `armv7` was dropped in 0.4.1 after Supervisor deprecated it.

> ⚠ **ADB is not a sandbox.** Several operations exposed here are destructive and some are irreversible without a factory reset — `adb_uninstall` removes app data, `pm disable-user`/`pm uninstall --user 0` on system packages can leave a device in a broken or unbootable state, and an AI assistant will execute what it is asked to. Start with `allow_shell: false` if you only need screenshots and UI control, and keep a way to recover each device.

## Why not the official MCP Server integration?

Home Assistant ships its own MCP Server integration, and it is the right tool for a different job. It exposes the **HA conversation agent** — the intents your assistant already understands (turn on a light, set a temperature). It does not give an assistant a shell, a screen, or a package manager on a device.

This app is at a different layer. It talks to Android over ADB directly, so the assistant can do the things HA has no entity for: read a crash log, dump the current UI tree and tap a coordinate, sideload an APK, disable a preinstalled package, pull a file off the box. If your device happens to be an Android TV that HA already tracks via the `androidtv` integration, the two coexist (see below) — this app simply operates below the level where entities exist.

Rule of thumb: if what you want is an entity, use the official integration. If what you want is a terminal and a screen, use this.

## Tools (16)

| Tool | Purpose | Notes |
|---|---|---|
| `adb_devices` | List connected devices | |
| `adb_connect` | Connect a network device | `ip` (port 5555 implied) or `ip:port`. Connection failures raise an error, not silent text |
| `adb_disconnect` | Disconnect one device | Other transports untouched |
| `adb_pair` | Pair Android 11+ (Wireless Debugging) | Needs `ip:port` **and 6-digit code from the pairing dialog** (both random; dialog must stay open) |
| `adb_shell` | Run any shell command | Disabled entirely when `allow_shell: false` |
| `adb_screenshot` | JPEG screenshot | Default 1024px / quality 70; optional `max_px` (320–1920), `quality` (30–95) when fine detail matters |
| `adb_ui_dump` | Compact UI hierarchy with tap coordinates | Auto-retries once (600 ms) if uiautomator returns a stale cached dump |
| `adb_tap` / `adb_swipe` / `adb_key` | Input control | Key names or keycodes (`HOME`, `BACK`, `WAKEUP`, …) |
| `adb_text` | Type into focused field | ASCII via `input text`; **non-ASCII (Cyrillic/emoji/CJK) via ADBKeyBoard** — see below |
| `adb_install` | Install APK(s) from `/media` or `/share` | One path → `adb install`. **Array of paths → `adb install-multiple`** for split APKs. Flags `-r -t -g` |
| `adb_uninstall` | Uninstall by package name | `keep_data` optional |
| `adb_push` / `adb_pull` | File transfer device ↔ HA | HA side restricted to `/media`, `/share`; returns transfer stats |
| `adb_logcat` | Non-blocking log dump | See filter semantics below |

### Split APKs (`install-multiple`)

Apps distributed as `.apks`/`.xapk` bundles are a base APK plus `config.*` splits. `adb` refuses the bundle itself (`filename doesn't end .apk`), and unpacking it on-device is not an option — Fire OS 7, for one, ships no `unzip`. Unpack on your PC, drop the parts into `/media`, and pass the ones the device actually needs:

```
adb_install apk_path=[
  "/media/apk/X-plore/com.lonelycatgames.Xplore.apk",
  "/media/apk/X-plore/config.armeabi_v7a.apk",
  "/media/apk/X-plore/config.xhdpi.apk",
  "/media/apk/X-plore/config.ru.apk"
]
```

Picking the splits is the caller's job — there is no bundletool in the container. Ask the device first:

```
adb_shell getprop ro.product.cpu.abilist   # armeabi-v7a,armeabi → 32-bit, do NOT ship arm64
adb_shell wm density                       # 320 → xhdpi
adb_shell getprop persist.sys.locale       # ru-RU → config.ru
```

Don't infer the ABI from the SoC or the Android version: plenty of Android TV boxes run a 32-bit userland on 64-bit silicon. To restore an app after a factory reset, `pm path <pkg>` on a working device lists the exact split set — pull those and pass them straight back.

### `adb_logcat` filter semantics

- **No filter** — last `lines` raw lines (`logcat -d -t N`).
- **Filterspec** (contains `:` or `*`), e.g. `ActivityManager:I *:S` or just `MyTag:D` — applied to the **whole** buffer on-device, tail on-device. `*:S` is auto-appended if you omit it, so unmatched tags stay silent.
- **Plain substring**, e.g. `bluetooth` — case-insensitive grep across whole lines, on-device.

Filtering/grep/tail all run on the device, so huge log buffers never cross the wire.

### Unicode input: ADBKeyBoard

Android's `input text` is ASCII-only. For anything else, `adb_text` automatically routes through the [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) IME: the current keyboard is remembered, switched to AdbIME for the broadcast, and restored afterwards (even on failure).

One-time setup per device: download `ADBKeyboard.apk`, push it and install:

```
adb_push  host_path=/media/.../ADBKeyboard.apk  device_path=/data/local/tmp/ADBKeyboard.apk
adb_shell pm install -r -t -g /data/local/tmp/ADBKeyboard.apk
adb_shell ime enable com.android.adbkeyboard/.AdbIME
```

Without it, non-ASCII input fails with an instructive error; ASCII always works.

## Installation

> **A note on wording.** Home Assistant renamed **add-ons** to **apps** in 2026.2 (February 2026) — the UI and the docs changed, nothing else did. `config.yaml`, `repository.yaml`, the store layout and the Supervisor API still say *add-on*, which is why the repository is still named `ha-adb-mcp`. The click paths below are for 2026.2 and newer; on an older core the same two places are called *Add-ons* and *Add-on Store*.

**1. Add this repository**

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fha-adb-mcp)

Or by hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste `https://github.com/st412m/ha-adb-mcp`, select **Add**.

*If the badge opens the App Store but no dialog appears, that is [my.home-assistant.io#698](https://github.com/home-assistant/my.home-assistant.io/issues/698), open since April 2026 — use the manual path above.*

**2. Install and configure**

In the new **ADB MCP Server** card: **Install**, then set a long random `token` in Configuration, then **Start**.

**3. Enable ADB on your devices**

- **Fire TV / Android TV**: Settings → Developer Options → ADB Debugging → ON. Network ADB listens on port 5555.
- **Phones/tablets (Android ≤10)**: enable USB debugging, connect via USB once, run `adb tcpip 5555`. Resets on reboot.
- **Phones/tablets (Android 11+)**: Wireless debugging → "Pair device with pairing code" → call `adb_pair` with the shown `ip:port` + 6-digit code (keep the dialog open) → `adb_connect` to the `ip:port` from the **main** Wireless debugging screen. The RSA key persists — re-pairing is never needed again, but the connect port changes after every reboot, so leave such devices out of `devices` auto-connect.

**4. Auto-connect stable devices on startup**

```yaml
token: "your-long-random-token"
devices:
  - "192.168.1.62"        # Fire TV, port 5555 implied
  - "192.168.1.80:5555"
allow_shell: true
log_requests: false
```

**5. Accept the debugging prompt**

On first connection, accept the **"Allow USB debugging?"** dialog on each device (check "Always allow"). ADB keys persist in `/data/.android` across app restarts and updates.

## Connecting claude.ai

Expose port 3200 through your reverse proxy (Caddy/nginx/Cloudflare Tunnel), then add a custom connector:

```
https://your-domain/private_<token>/mcp
```

## Known limitations

- **Tool list is cached per chat.** After updating the app, an already-open chat keeps the old tool schemas. Start a new one to see new tools or changed parameters. (As of 0.5.1 an array parameter still works even against a stale string schema — the server coerces it — but the description you see will be outdated.)
- **Gateway timeout ~60 s per tool call.** Long-running shell commands will be cut off by the connector, not by the app. Background them on-device and poll, rather than blocking.
- **aarch64 is build-verified, not device-verified.** See Platforms above.
- **Screenshots wake devices.** `screencap` on a sleeping Android TV wakes it, and HDMI-CEC will happily switch on the television attached to it. Worth remembering before scripting a screenshot loop.
- **One adb session per device.** Android's adbd does not tolerate two independent TCP clients; if you also use the `androidtv` integration, route it through this app's adb server — see below.

### Timeouts and failure behaviour

Every ADB invocation runs under a hard timeout and is killed when it expires, so a device that sleeps, reboots or drops off the network fails the call instead of hanging it. The error is returned as a normal MCP tool result with `isError: true` and a text message — never a stalled request.

| Tool | Timeout |
|---|---|
| `adb_connect` / `adb_disconnect` | 10 s |
| `adb_pair`, `adb_logcat` | 20 s |
| `adb_shell` | 30 s, raised to at most 120 s via `timeout_sec` |
| `adb_screenshot`, `adb_ui_dump`, `adb_tap` / `adb_swipe` / `adb_key` / `adb_text` | 30 s |
| `adb_uninstall` | 60 s |
| `adb_push` / `adb_pull` | 120 s |
| `adb_install` | 180 s |

Common ADB failures are rewritten with the action that fixes them, e.g. `device offline` returns *"the TCP session died (device slept or rebooted) — run `adb_disconnect` for this host, then `adb_connect` again"*, and `device not found` points at `adb_devices`.

One caveat worth knowing: `adb_install`, `adb_push`, `adb_pull` and `adb_uninstall` allow more time than the ~60 s gateway timeout above. On a genuinely long transfer the connector will give up before the app does, so the boundary you hit first is your reverse proxy, not this code. The auth proxy itself sets no timeout — it is a plain pipe.

## Coexistence with the androidtv integration

The HA `androidtv` integration by default connects to devices **directly** (python adb-shell), and Android's adbd dislikes two independent TCP clients — sessions will fight. Solution: this app runs a classic adb server (`adb -a`) on port 5037. Map `5037/tcp` in the app's network config, then point the androidtv integration at *ADB server* = HA host IP, port 5037. The integration and this MCP server then share one adb daemon and one device session.

Heads-up: `adb_server_ip` is not in the integration's options flow — switching an existing entry means deleting and re-adding it. Entity IDs survive if the device `unique_id` (MAC) is unchanged.

## Config options

| Option | Default | Description |
|---|---|---|
| `token` | `changeme` | Secret path token. **Change it.** |
| `devices` | `[]` | List of `ip` or `ip:port` to auto-connect at startup. Don't list Android 11+ wireless-debug devices (random ports) |
| `allow_shell` | `true` | `false` disables the raw `adb_shell` tool. Internal plumbing (ui_dump, unicode input, logcat filters) keeps working |
| `log_requests` | `false` | Two logs at once: HTTP access log in the auth proxy (IP, method, masked path, status) **and** per-tool-call log in the server (`[tool] <ISO> <name> <args> -> ok NB \| image NKB \| ERROR <msg> <ms>`) |

## Troubleshooting

**`INSTALL_FAILED_VERIFICATION_FAILURE`** — the on-device package verifier is rejecting ADB installs. It is a separate switch from `package_verifier_enable`, and its default (unset) means *enabled*:

```
adb_shell settings put global verifier_verify_adb_installs 0
```

Seen on certified Android TV devices with Play Services. Devices without Play Protect (Fire OS, for instance) never hit this regardless of the setting, because there is no verifier agent to consult.

**An Android app looks dead right after installing it** — after a replace, dexopt runs before the first launch, so the process can take noticeably longer than usual to appear. Check logcat for an actual `FATAL` before concluding it crashed. `VerityUtils: Failed to measure fs-verity` in the log after a sideload is normal, not an error.

**`device offline` / `device not found`** — the TCP session died (device slept or rebooted). `adb_disconnect` that host, then `adb_connect` again. For Android 11+ wireless debugging, the port changes after every reboot.

## Security notes

- The token in the URL path is the only auth layer — use a long random value and HTTPS.
- `adb_shell` is full device shell access. Disable it (`allow_shell: false`) if you only need screenshots/UI control.
- `adb_push`/`adb_pull`/`adb_install` are restricted to `/media` and `/share` on the HA side.
- **Never expose port 5037 beyond your LAN** — the adb server has no auth at all.

## License

MIT — see [LICENSE](LICENSE).
