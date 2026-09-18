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

> **New tools or changed parameters are not visible until a new chat.** MCP
> clients cache `tools/list` per conversation, so an already-open chat keeps
> the old schemas after you update the add-on. Start a new conversation.

### What `log_requests: true` actually writes

The tool-call log masks the values it knows are secrets: `adb_text.text`
becomes `<N chars>`, `adb_pair.code` becomes `***`, and any top-level
argument whose name matches `/pass|secret|token/i` is masked as a safety net
for parameters added later. The same masking is applied to error text, both
in the log and in what the client receives, because a chat transcript is
saved and forwarded the same way the log is — an error message that echoed
the raw text you typed would leak it through a different door.

**`adb_shell.command` is never masked.** It is an arbitrary administrator
command, not a fixed-shape argument, and there is no way to tell a secret
apart from the rest of it. If you need to type a password on-device, use
`adb_text`, not `input text "..."` run through `adb_shell` — the former is
masked, the latter is logged and echoed back verbatim like any other shell
command.

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

### `adb_screenshot` geometry, and `coords="screenshot"` on `adb_tap`/`adb_swipe`

The image `adb_screenshot` returns is downscaled to `max_px` (1024 by
default), so coordinates read directly off that picture would miss unless
rescaled. The tool follows the image with a text line naming the logical
screen size, the image size, and the scale between them:

```
screen 1920x1080 (кадр 3840x2160) → image 1024x576 · scale 1.875/1.875 · для adb_tap/adb_swipe передай coords="screenshot"
```

**Two different sizes are in play, and they don't always differ.**
`input tap` and `uiautomator` — and therefore `adb_ui_dump` — operate in the
*logical* size reported by `wm size` (its `Override size:` line if the
device has one, otherwise `Physical size:`). `screencap` captures a PNG
that may or may not match that logical size — which one depends on the
device, not on a fixed rule. Confirmed on the fleet (2026-09-18), each
verified by tapping a specific on-screen pixel:

| Device | `wm size` | What `screencap` actually returns | `(кадр ...)` shown? |
|---|---|---|---|
| Nvidia Shield | Physical 3840×2160, Override 1920×1080 | Physical: 3840×2160 | yes |
| Fire TV AFTKA | Physical 3840×2160, Override 1920×1080 | **Logical**: 1920×1080 (confirmed from the PNG header) | no |
| TiVo Stream 4K | Physical 1920×1080 only, no `Override` line | 1920×1080 | no |
| Samsung S22 (SDK 36) | Physical 1080×2340 only, no `Override` line | matches current orientation | no |
| Galaxy Watch 6 (SM-R960, SDK 36) | Physical 480×480 only, no `Override` line | 480×480 | no |

The watch is the only case where the screen is *smaller* than `max_px`:
`-resize`'s `>` flag means the image is neither shrunk nor enlarged, so the
response is `screen 480x480 → image 480x480 · scale 1.000/1.000` — a
straight 1:1 mapping, confirmed by a `coords="screenshot"` tap landing
correctly at that scale.

**Do not simplify this to "if there's an `Override` line, halve it" — that
breaks on the Fire TV**, which has the identical `wm size` output as the
Shield but hands back an already-logical-sized PNG. The only correct rule
is the general one implemented here: measure the actual PNG, measure the
actual logical size, and compare them. `screen ... → image ...` always
shows the logical size; **`(кадр ...)` appears if and only if the measured
PNG size differs from the logical size** — on this device, on this
particular screenshot — never inferred from a model or vendor name.
Confirmed to be system-wide rather than per-app: identical inside a running
app (Immich TV on the Shield) and on its launcher.

**Rotation.** On the S22 in landscape, `wm size` kept reporting the
portrait `1080x2340` it always reports, while the PNG came back
`2340x1080`. The tool detects the mismatch from the PNG (the source of
truth for current rotation) and swaps the logical width/height to match —
confirmed correct: `screen 2340x1080 · scale 2.285/2.283`, and the
resulting `coords="screenshot"` tap landed on target.

`wm size` is read **fresh on every screenshot**, in the same call that
takes the PNG — it is not cached, because the Shield can switch its
physical display mode to match content on the fly, changing the
frame-to-logical ratio between two consecutive screenshots (not directly
observed on the fleet above, but this is why it isn't cached). If `wm
size` cannot be read or parsed, the tool falls back to the frame size (the
old behaviour) and says so explicitly in the response rather than silently
guessing a ratio — not exercised on real hardware, only in synthetic tests.

Pass `coords="screenshot"` to `adb_tap`/`adb_swipe` to use coordinates read
straight off that image; they are rescaled automatically using the numbers
above. This only works within 120 seconds of the screenshot, and only when
`serial` was passed identically to both calls (a screenshot taken without
`serial` and a tap with `serial` are different device keys) — an older or
missing screenshot is refused rather than guessed. `coords="screen"` (the
default) means coordinates from `adb_ui_dump` — the same logical space
`input tap` uses natively, no rescaling involved. Rotation between the
screenshot and the tap is **not** checked either way.

### A near-uniformly dark screenshot

A screenshot that comes back almost completely dark (mean brightness and
standard deviation both under a small threshold) is reported as a
**warning after the image, not a refusal** — a real dark frame is legitimate
(a paused dark scene, a screensaver), and refusing would take the picture
away exactly where it is needed. Two pieces of evidence are attached when
they can be read, both optional:

```
⚠ кадр почти равномерно тёмный (mean 0.004, sd 0.001). Экран: Asleep
⚠ кадр почти равномерно тёмный (mean 0.004, sd 0.001). Экран: Awake, окно в фокусе с FLAG_SECURE — содержимое скрыто системой
⚠ кадр почти равномерно тёмный (mean 0.004, sd 0.001). Экран: Awake, признак защиты не найден — возможно, кадр действительно чёрный
```

`Экран:` comes from `dumpsys power`'s `mWakefulness`, confirmed working: a
sleeping Shield returns a normal-sized black 3840×2160 frame (not the
empty-file case handled separately), and the warning fires correctly —
`mean 0.004, sd 0.000, Экран: Asleep`. The dark Google TV launchers on the
Shield and TiVo were checked specifically for a false positive and did not
trigger the warning at all.

The `FLAG_SECURE` note comes from the focused window's flags in `dumpsys
window windows`, filtered on-device (the full dump can run to several
hundred KB and is never pulled into Node). **On Android 16 (SDK 36, tested
on a Galaxy S22) this signal is not available at all, for two independent
reasons.** First, `dumpsys window windows` on this build never prints an
`mCurrentFocus` line at all — that line only appears in the separate
`dumpsys window` (without `windows`) — so the in-focus window's hash can't
be found, and the function returns "not determined" before it would even
get to reading `fl=`. Second, even where `fl=` values do appear on this
build, they're printed as a bare number (`fl=1000208`) with no `SECURE`
token anywhere in the dump (`grep -c` for it is 0), so the named-flags
branch this code also supports would not have matched either. Both are
honest "not determined" outcomes, not a guess. On SDK 28–31 (the TV boxes)
this signal was not exercised in this acceptance round — the warning
there is currently limited to `mWakefulness`. If a genuinely empty
screencap (exit 98, "device asleep or protected content?") happens instead
of a normal-sized dark frame, the same `mWakefulness` reading is appended
to that error when it can be read.

### `verify` on `adb_tap`, `adb_swipe`, `adb_key`

`verify: "none"` (default) | `"activity"` | `"ui"` checks whether the action
actually changed anything, instead of you taking a follow-up screenshot to
find out.

- `"activity"` compares the resumed activity before the action to after it:
  `resumed: A → B`, or `resumed: без изменений (A)` if it's the same
  component. If the component can't be determined either time, you get
  `resumed: не определено` rather than a guess.
- `"ui"` does everything `"activity"` does, plus a hash of the UI dump
  before/after. If the hashes match, it waits 600ms and dumps once more (an
  animation may not have finished yet) before deciding: `ui: изменился` /
  `ui: не изменился`. For `adb_swipe`, `ui: не изменился` is annotated —
  for a swipe this usually means you reached the end of a scrollable list,
  not that nothing happened.
- The hash strips every `com.android.systemui` node first, or a status-bar
  clock would report "changed" on every single call. Focus and selection
  are **not** stripped — for a DPAD key press that is the change being
  measured. **Known limitation, confirmed live, not just in theory:** two
  `adb_ui_dump` calls in a row with no action in between, on a YouTube
  video, came back with different text purely because the on-screen
  progress timer ticked from "0 минут 18 секунд" to "0 минут 25 секунд" —
  and `adb_key VOLUME_MUTE verify="ui"` reported `изменился` on both tries.
  That live element is never inside `com.android.systemui`, so stripping
  systemui nodes does not help it. What counts as the culprit is
  screen-dependent, not a fixed list, and it turns up across unrelated
  device classes: the Google TV launcher (Shield, TiVo) has a clock
  (`id=clock`); Fire TV's launcher has no clock but a full-screen carousel
  (`featured_item_rotator`) that rotates on its own; a Galaxy Watch 6 watch
  face dump contains a `[BTN] 16:52 Новые уведомления` node with the same
  problem — the time is drawn outside systemui there too. `"не изменился"`
  stays reliable regardless of which live element is on screen, since it
  only fires when literally nothing changed.
- `"ui"` costs two to three extra full UI dumps, roughly 2–4 seconds — that
  is why it is not the default.
- **A verify failure never turns a performed action into an error.** The
  action has already happened by the time verify runs, so a `uiautomator`
  hiccup shows up as
  `ui: не определено (uiautomator: ...)` next to a normal success line, not
  as a tool error — **confirmed live on a Galaxy Watch 6 with its screen
  off**: `uiautomator` failed with `ERROR: null root node returned by
  UiTestAutomationBridge`, and the tool still returned
  `Tapped (240, 262) — из координат снимка (240,262) × 1.000/1.000 ·
  resumed: A → B · ui: не определено (uiautomator: ERROR: null root node
  ...)` — the tap and the `resumed` check both went through cleanly, only
  `ui` came back undetermined. With the watch screen awake, both a plain
  dump and `verify="ui"` (a DPAD_DOWN on the watch face reported `ui: не
  изменился`, correctly) worked normally — the failure tracks the screen
  being off, not Wear OS in general. Video playback specifically (Immich,
  YouTube fullscreen and windowed, on a Galaxy S22) still has not
  reproduced this.

`adb_find_and_tap` has its own reporting and is not affected by `verify`.

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

### Intent / deep-link launch

`action=launch` also accepts `uri` and/or `intent_action` instead of relying
on the package's main activity — `am start -W -a <action> [-d <uri>]
[-p <pkg>] [extras...]`:

```
adb_app action=launch intent_action=android.settings.APPLICATION_DETAILS_SETTINGS uri="package:com.lonelycatgames.Xplore"
adb_app action=launch uri="https://example.com/some/deep/link"
```

`intent_action` defaults to `android.intent.action.VIEW` once `uri` is set.
`packages` is optional here; a single package narrows the resolver with
`-p` (more than one is a refusal — this isn't a list of recipients).
`extras` maps `string → --es`, `boolean → --ez`, an integer that fits in
int32 `→ --ei`, a larger integer `→ --el`, and refuses anything else by
naming the offending key; it also accepts a JSON-stringified object, the
same client quirk `adb_app`'s array parameters already work around.

**`intent_action=android.intent.action.CALL`/`CALL_PRIVILEGED`/
`CALL_EMERGENCY` is refused while `allow_shell: false`**, regardless of
whether the call would actually go through — sources disagree on whether
the `shell` uid can dial through this intent at all, and settling that
means placing a real call, which this add-on will not do to find out. The
point of the refusal is narrower and doesn't depend on the answer: a
disabled `adb_shell` must not become a quiet side door back to dialing.
`allow_shell: true` does not refuse this, since `adb_shell` can already
place calls anyway.

The `-W` output is parsed by line prefix, not by scanning the whole text for
"error" — a URI containing that word, or the success message for "intent
delivered to the already-open app" (whose text contains "Activity not
started"), would otherwise misfire. If the intent resolves to a chooser
dialog, the tool presses `KEYCODE_BACK` once to close what it opened and
reports that multiple handlers exist; it never presses more than one key or
retries automatically.

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
