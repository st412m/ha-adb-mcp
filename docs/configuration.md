# Configuration

What each add-on option does beyond its one-line description in the README, and what changing it costs.

## `token`

The secret path prefix. It is the only authentication layer, so use a long random value and serve the endpoint over HTTPS. Changing it changes the connector URL.

## `devices`

Hosts auto-connected at startup, as `ip` (port 5555 implied) or `ip:port`.

Do not list Android 11+ wireless-debugging devices here. Their connect port is random and changes after every reboot, so a fixed entry goes stale on its own. Connect those with `adb_connect` when needed.

## `allow_shell`

`false` disables the `adb_shell` tool outright; the call returns `adb_shell is disabled in addon config (allow_shell: false)`.

Internal plumbing keeps working: `adb_ui_dump`, unicode input through ADBKeyBoard, `adb_logcat` filters and everything `adb_app` does still run their own shell commands.

`allow_shell: false` also makes `adb_app action=launch` refuse `intent_action=android.intent.action.CALL`, `CALL_PRIVILEGED` and `CALL_EMERGENCY`, so a disabled shell does not leave a way to place a call. With `allow_shell: true` there is no such refusal.

Start here if all you need is screenshots and UI control.

## `allow_uninstall`

`true` unlocks `adb_app mode=uninstall`. Off by default; `mode=disable` is reversible and covers nearly every case.

Turning it on does not bypass anything else: the derived protected set, the account canary and the mandatory APK backup all still apply, and the call still needs an explicit `mode` plus `dry_run=false`.

## `log_requests`

Turns on two logs at once:

- an HTTP access log in the auth proxy — IP, method, masked path, status;
- a per-tool-call log in the server: `[tool] <ISO> <name> <args> -> ok NB | image NKB | ERROR <msg> <ms>`.

Arguments are masked before they are truncated to 300 characters. `adb_text.text` becomes `<N chars>`, `adb_pair.code` becomes `***`, and any top-level key matching `pass`, `secret` or `token` becomes `***`. The same secrets are stripped out of error text on the way out, in their plain, `input text`-escaped and base64 forms.

`adb_shell.command` is **not** masked. It is an arbitrary administrator command with no fixed shape to mask, and it is logged verbatim. Type secrets through `adb_text`, not through `input text` run via `adb_shell`.

## `store` (per call, not an add-on option)

`adb_app` writes its rollback snapshot and APK backups under `store`, default `/media/adb-mcp`. The path must be under `/media` or `/share`; anything else is refused with `Access denied (host path outside /media, /share)`.

Those APKs are readable by anything else with access to `/media`.

## Ports

| Port | Purpose |
|---|---|
| `3200/tcp` | the auth proxy and the MCP endpoint, published — the only port a client connects to |
| `3199/tcp` | the MCP server behind the proxy, internal to the container, never published |
| `5037/tcp` | the classic adb server, unpublished by default |

Map `5037/tcp` only to share the adb daemon with the `androidtv` integration — see [coexistence-androidtv.md](coexistence-androidtv.md). The adb server has no authentication of any kind, so never expose it beyond the LAN.
