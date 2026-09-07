# ADB MCP Server

An MCP server over Streamable HTTP that lets an assistant operate Android
devices on your network over ADB — shell, screenshots, UI automation, app
installation including `.apks` bundles, file transfer, logcat, and package
management with guard rails.

## Configuration

| Option | Default | What it does |
|---|---|---|
| `token` | `changeme` | Secret in the URL path. The endpoint is `http://<host>:3200/private_<token>/mcp`. Change it. |
| `devices` | `[]` | Devices to connect on start, `ip` or `ip:port` (port defaults to 5555). Leave phones and watches out of this list — their Wireless Debugging port is random and changes on every reboot. |
| `allow_shell` | `true` | Exposes `adb_shell`. Turning it off blocks only the user-facing tool; the internal shell paths other tools rely on keep working. |
| `allow_uninstall` | `false` | `true` unlocks `adb_app mode=uninstall`. Leave it off unless you are actually removing packages — `mode=disable` is reversible and covers nearly every case. |
| `log_requests` | `false` | Log every proxied request and every tool call (name, arguments, duration, response size or error). |

Port `3200` is the auth proxy and the only one you connect to; `3199` (the MCP
server) is internal. Port `5037` is the adb server itself, published to the LAN
so the Home Assistant `androidtv` integration can share it — see
*Coexistence* below.

ADB RSA keys live in `/data/.android`, so pairing survives add-on restarts and
updates.

## Connecting a device

Boxes with ADB over TCP always on (Fire TV, Shield, TiVo and most Android TV
devices) need `adb_connect` once and then accept the *Always allow* dialog on
screen. Put them in `devices` afterwards.

Phones and watches on Android 11+ use Wireless Debugging, which has two
different random ports: one shown in the *Pair device with pairing code*
dialog, one on the main Wireless Debugging screen. Pair with `adb_pair` using
the first, then `adb_connect` with the second. The pairing survives reboots;
the ports do not.

## Tools

Read-only: `adb_devices`, `adb_screenshot`, `adb_ui_dump`, `adb_logcat`.

Device control: `adb_connect`, `adb_pair`, `adb_disconnect`, `adb_shell`,
`adb_tap`, `adb_swipe`, `adb_text`, `adb_key`, `adb_find_and_tap`.

Files and packages: `adb_push`, `adb_pull`, `adb_install`, `adb_uninstall`,
`adb_app`.

`adb_push` and `adb_pull` only reach `/media` and `/share` on the Home
Assistant side; anything outside is refused.

### `adb_install` and `.apks` bundles

`apk_path` takes a single `.apk`, an array of split APKs installed atomically
through `install-multiple`, or one `.apks` / `.xapk` / `.apkm` bundle. A bundle
is unpacked add-on side, so the device needs no `unzip` — which matters on Fire
OS, where there is none. Splits are chosen from the device's real ABI list,
screen density and locale.

A missing ABI split is an error and nothing is installed: the app would not
start. A density mismatch is not fatal, because resources fall back to the base
APK, so the nearest bucket is used and the mismatch reported. `dry_run=true`
shows the selection without installing.

If an install fails with `INSTALL_FAILED_VERIFICATION_FAILURE`, the on-device
verifier is rejecting ADB installs. Disable it once with
`settings put global verifier_verify_adb_installs 0`.

### `adb_find_and_tap`

Finds an element by `text`, `resource_id` or `desc` and activates it in one
call. How it activates is derived from the device rather than assumed: with a
touchscreen it taps the element's centre; on a leanback TV box, where a
coordinate tap actually activates whatever currently holds focus, it walks the
focus there with DPAD keys and presses DPAD_CENTER.

Nothing is assumed to have worked — the UI is re-dumped after every key press
and the focus re-checked. If focus stops moving, starts cycling between the
same nodes, or the target is not reached within `max_steps` or the internal
time budget, the tool reports where it stopped and presses **nothing**. A
silent miss on a television is worse than a clear refusal.

## `adb_app` and its guard rails

Bulk package work is where an assistant can do real damage, so this tool is
built assuming it will eventually be asked to do something wrong. The design
comes from a real incident: a Fire TV was debloated from a public "safe list",
silently lost its Amazon account registration, hung on re-login, and needed a
factory reset.

`list`, `info`, `protected` and `state` are read-only. `launch`, `stop` and
`clear` act on one app at a time. `disable`, `uninstall`, `enable`, `restore`
and `backup` change state.

- **Everything that changes state defaults to `dry_run: true`.** You get the
  plan, the rollback path per package and any advisories. `stop` is the one
  exception — it acts immediately, because a force-stop is momentary.
- **The protected set is derived from the device, never hardcoded.** Current
  launcher, active IME, package installer, WebView provider, role holders where
  the OS exposes them, packages that register an account authenticator, and
  system packages holding a listening socket. Any overlap **aborts the whole
  call** — partial application is worse than a refusal, and there is no
  override flag for this one.
- **A package currently serving an off-device client is refused.** The network
  guard covers `disable`, `uninstall`, `stop` and `clear`. It fires when the
  package holds a listening TCP socket *and* something outside the device is
  connected to that same port right now. The refusal names the port and the
  peer. This is the failure the account canary structurally cannot see: the
  accounts are intact, the launcher resolves, and the service your automation
  was talking to is dead. Lifted only by `force_network: true`, which does not
  lift the protected set.
- **An account canary runs between batches.** Losing device registration is a
  latent failure — the device boots, apps open, and you find out at the store.
  The canary reads the account count (counts and types only, never account
  names) and re-resolves the launcher; a drop rolls that batch back and stops.
- **Everything applied is written to a snapshot** under `store` (default
  `/media/adb-mcp/<device>/state.json`), so `action=restore` undoes it in one
  call. `pm disable-user` was always reversible — what is usually missing is a
  record of *what* was disabled.
- **`mode=uninstall` sits behind three locks:** the `allow_uninstall` option,
  an explicit `mode` in the call, and a successful APK backup. `force: true`
  overrides a failed backup and nothing else; it is deliberately a different
  flag from `force_network`.

`action=backup` pulls a package's APKs including every split, plus a
`manifest.json` recording version, ABI and the split list. Useful on its own
before a factory reset.

### Why the network guard is derived rather than listed

The case that produced it: on an Android 11 box, `com.google.android.tv.remote.service`
holds ports 6466/6467 and is what the Home Assistant `androidtv_remote`
integration talks to. Disabling it kills the integration silently. Adding that
package name to a list in the code would protect exactly the setup it was
written on — on another vendor's device the channel is held by a different
package, and the add-on would remove it with a clear conscience. A signal taken
from the device works on hardware the author has never seen.

Two distinctions carry the whole signal. A listening socket alone means
nothing much: plenty of apps listen speculatively, and refusing on that would
make every torrent server and VPN client undisableable. An `ESTABLISHED` row
alone means nothing either — with a high local port it is an outbound
connection the app opened, and a media box has dozens at any moment. A peer on
loopback does not count, because that client is on the same device.

A socket belonging to a uid shared by several packages cannot be attributed to
any one of them. When such a uid is serving an external client, the guard
refuses and says the link is unproven rather than passing it over quietly. If
`/proc/net` cannot be read at all, the output reports the guard as blind
instead of pretending it passed.

## Coexistence with the `androidtv` integration

Both can use the same device. The add-on publishes the adb server on port
`5037`, so point the integration at `<ha-ip>:5037` instead of letting it start
its own — two adb servers competing for one device produce dropped connections.

## Security

The token sits in the URL path, so treat the endpoint as a secret and do not
expose port `3200` to the internet without a reverse proxy that terminates TLS.

ADB is not a sandbox. Anything the assistant can do through this add-on, it can
do to the device: read files, install software, remove packages. `allow_shell`
and `allow_uninstall` exist so you can narrow that.

Account names are never returned by any tool — the canary reads counts and
types only.

## Troubleshooting

**A device shows as `offline` or `unauthorized`.** Accept the debugging dialog
on the device screen, then `adb_disconnect` and `adb_connect` again.

**A phone or watch stopped connecting.** Its Wireless Debugging port changed
after a reboot. Read the new one from the device and `adb_connect` again — no
re-pairing needed.

**New tools or changed parameters are not visible.** MCP clients cache the tool
list per conversation. Start a new conversation after updating the add-on.

**A `dry_run` looks right but the real call is refused.** Read the refusal: the
protected set and the network guard both explain exactly which package and
which signal stopped the call.
