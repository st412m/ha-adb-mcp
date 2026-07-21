# ADB MCP Server — Home Assistant Addon

MCP (Model Context Protocol) server for controlling Android devices over **network ADB**, packaged as a Home Assistant addon. Lets AI assistants (claude.ai custom connectors, Claude Desktop, etc.) see and control Android TVs, Fire TVs, phones, tablets and watches on your LAN: run shell commands, take screenshots, inspect and tap UI, type text (incl. Unicode), install apps, transfer files, read logcat.

Transport: MCP Streamable HTTP (`POST /mcp`, plain JSON responses — immune to SSE buffering in CDNs/tunnels). Auth: secret path prefix `/private_<token>`, same pattern as [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp).

**Platforms:** built for amd64andaarch64. Developed and battle-tested on amd64 (HAOS); reports from other architectures are welcome — please open an issue. armv7 was dropped in 0.4.1: Home Assistant Supervisor deprecated the architecture (it warned on every install), and the arch-less base images are following suit.

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
| `adb_install` | Install APK from `/media` or `/share` | Flags `-r -t -g`: reinstall, testOnly/debug builds allowed, permissions granted |
| `adb_uninstall` | Uninstall by package name | `keep_data` optional |
| `adb_push` / `adb_pull` | File transfer device ↔ HA | HA side restricted to `/media`, `/share`; returns transfer stats |
| `adb_logcat` | Non-blocking log dump | See filter semantics below |

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

1. Settings → Add-ons → Add-on Store → ⋮ → Repositories → add `https://github.com/st412m/ha-adb-mcp`
2. Install **ADB MCP Server**, set a long random `token` in the config, start.
3. Enable ADB on your devices:
   - **Fire TV / Android TV**: Settings → Developer Options → ADB Debugging → ON. Network ADB listens on port 5555.
   - **Phones/tablets (Android ≤10)**: enable USB debugging, connect via USB once, run `adb tcpip 5555`. Resets on reboot.
   - **Phones/tablets (Android 11+)**: Wireless debugging → "Pair device with pairing code" → call `adb_pair` with the shown `ip:port` + 6-digit code (keep the dialog open) → `adb_connect` to the `ip:port` from the **main** Wireless debugging screen. The RSA key persists — re-pairing is never needed again, but the connect port changes after every reboot, so leave such devices out of `devices` auto-connect.
4. Auto-connect stable devices on startup:

```yaml
token: "your-long-random-token"
devices:
  - "192.168.1.62"        # Fire TV, port 5555 implied
  - "192.168.1.80:5555"
allow_shell: true
log_requests: false
```

5. On first connection, accept the **"Allow USB debugging?"** dialog on each device (check "Always allow"). ADB keys persist in `/data/.android` across addon restarts and updates.

## Connecting claude.ai

Expose port 3200 through your reverse proxy (Caddy/nginx/Cloudflare Tunnel), then add a custom connector:

```
https://your-domain/private_<token>/mcp
```

Note: claude.ai caches the tool list per chat — after updating the addon, start a new chat to see new tools/schemas.

## Coexistence with the androidtv integration

The HA `androidtv` integration by default connects to devices **directly** (python adb-shell), and Android's adbd dislikes two independent TCP clients — sessions will fight. Solution: this addon runs a classic adb server (`adb -a`) on port 5037. Map `5037/tcp` in the addon's network config, then point the androidtv integration at *ADB server* = HA host IP, port 5037. The integration and this MCP server then share one adb daemon and one device session.

Heads-up: `adb_server_ip` is not in the integration's options flow — switching an existing entry means deleting and re-adding it. Entity IDs survive if the device `unique_id` (MAC) is unchanged.

## Config options

| Option | Default | Description |
|---|---|---|
| `token` | `changeme` | Secret path token. **Change it.** |
| `devices` | `[]` | List of `ip` or `ip:port` to auto-connect at startup. Don't list Android 11+ wireless-debug devices (random ports) |
| `allow_shell` | `true` | `false` disables the raw `adb_shell` tool. Internal plumbing (ui_dump, unicode input, logcat filters) keeps working |
| `log_requests` | `false` | Two logs at once: HTTP access log in the auth proxy (IP, method, masked path, status) **and** per-tool-call log in the server (`[tool] <ISO> <name> <args> -> ok NB | image NKB | ERROR <msg> <ms>`) |

## Security notes

- The token in the URL path is the only auth layer — use a long random value and HTTPS.
- `adb_shell` is full device shell access. Disable it (`allow_shell: false`) if you only need screenshots/UI control.
- `adb_push`/`adb_pull`/`adb_install` are restricted to `/media` and `/share` on the HA side.
- **Never expose port 5037 beyond your LAN** — the adb server has no auth at all.

## License

MIT
