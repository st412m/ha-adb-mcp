# ADB MCP Server — Home Assistant Addon

MCP (Model Context Protocol) server for controlling Android devices over **network ADB**, packaged as a Home Assistant addon. Lets AI assistants (claude.ai custom connectors, Claude Desktop, etc.) see and control Android TVs, Fire TVs, phones, tablets and watches on your LAN: run shell commands, take screenshots, inspect and tap UI, install apps, transfer files, read logcat.

Transport: MCP Streamable HTTP (`POST /mcp`, plain JSON responses — immune to SSE buffering in CDNs/tunnels). Auth: secret path prefix `/private_<token>`, same pattern as [ha-filesystem-mcp](https://github.com/st412m/ha-filesystem-mcp).

## Tools (v0.2.0)

| Tool | Purpose |
|---|---|
| `adb_devices` | List connected devices |
| `adb_connect` / `adb_disconnect` | Manage network ADB connections |
| `adb_pair` | Pair with Android 11+ devices (Wireless Debugging pairing code) |
| `adb_shell` | Run shell commands (`settings`, `pm`, `am`, `dumpsys`, ...) |
| `adb_screenshot` | Screenshot as JPEG (downscaled to 1280px) |
| `adb_ui_dump` | Compact UI hierarchy with tap coordinates |
| `adb_tap` / `adb_swipe` / `adb_text` / `adb_key` | Input control |
| `adb_install` / `adb_uninstall` | App management (APKs from `/media` or `/share`) |
| `adb_push` / `adb_pull` | File transfer device ↔ HA (`/media`, `/share` only) |
| `adb_logcat` | Non-blocking log dump with filters |

## Installation

1. Settings → Add-ons → Add-on Store → ⋮ → Repositories → add `https://github.com/st412m/ha-adb-mcp`
2. Install **ADB MCP Server**, set a long random `token` in the config, start.
3. Enable ADB on your devices:
   - **Fire TV / Android TV**: Settings → My Fire TV → Developer Options → ADB Debugging → ON. Network ADB is always available on port 5555.
   - **Phones/tablets (Android ≤10)**: enable USB debugging, connect via USB once, run `adb tcpip 5555`. Resets on reboot.
   - **Phones/tablets (Android 11+)**: Wireless debugging → "Pair device with pairing code", then use the `adb_pair` tool with the shown `ip:port` and 6-digit code, then `adb_connect` to the ip:port from the main Wireless debugging screen. Both ports are random and change after reboot.
4. Add devices to the addon config to auto-connect on startup:

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

## Coexistence with the androidtv integration

The HA `androidtv` integration by default connects to devices **directly** via `adb_shell` (python), and Android's adbd dislikes two independent TCP clients — sessions will fight. Solution: this addon exposes the classic adb server on port 5037 (disabled by default; map the port in addon network config to enable). Point the androidtv integration's *ADB server* option at the HA host, port 5037 — then both the integration and this MCP server share one adb daemon and one device session.

## Config options

| Option | Default | Description |
|---|---|---|
| `token` | `changeme` | Secret path token. **Change it.** |
| `devices` | `[]` | List of `ip` or `ip:port` to auto-connect at startup |
| `allow_shell` | `true` | Set `false` to disable the raw `adb_shell` tool |
| `log_requests` | `false` | Request logging in the auth proxy (IP, method, masked path, status) |

## Security notes

- The token in the URL path is the only auth layer — use a long random value and HTTPS.
- `adb_shell` is full device shell access. Disable it (`allow_shell: false`) if you only need screenshots/UI control.
- `adb_push`/`adb_pull`/`adb_install` are restricted to `/media` and `/share` on the HA side.

## License

MIT
