# Tools

Full semantics of every tool: arguments that change behaviour, guard rails, refusal rules, timeouts.

## Timeouts and failure behaviour

Every ADB invocation runs under a hard timeout and is killed when it expires, so a device that sleeps, reboots or drops off the network fails the call instead of hanging it. The error comes back as a normal MCP tool result with `isError: true` and a text message.

| Tool | Timeout |
|---|---|
| `adb_devices` | 30 s |
| `adb_connect` / `adb_disconnect` | 10 s |
| `adb_pair`, `adb_logcat` | 20 s |
| `adb_shell` | 30 s, raised to at most 120 s via `timeout_sec` |
| `adb_screenshot`, `adb_ui_dump`, `adb_tap` / `adb_swipe` / `adb_key` / `adb_text` | 30 s |
| `adb_find_and_tap` | 30 s per ADB call, plus an internal ~25 s budget for the whole DPAD walk |
| `adb_uninstall` | 60 s |
| `adb_push` / `adb_pull` | 120 s |
| `adb_install` | 180 s, 300 s for a bundle |
| `adb_app` | per underlying call; APK pulls get 180 s |

Common ADB failures are rewritten with the action that fixes them. `device offline` returns `The TCP session died (device slept or rebooted) - run adb_disconnect for this host, then adb_connect again.`, and `device not found` points at `adb_devices`.

`adb_install`, `adb_push`, `adb_pull` and `adb_uninstall` allow more time than the ~60 s gateway timeout of a typical reverse proxy. On a long transfer the connector gives up before the add-on does. The auth proxy sets no timeout of its own.

## Installing `.apks` bundles

Apps distributed as `.apks`/`.xapk`/`.apkm` bundles are a base APK plus `config.*` splits. `adb` refuses the bundle itself (`filename doesn't end .apk`), and unpacking it on-device is not an option on firmware that ships no `unzip`. Pass the bundle and let the add-on do it:

```
adb_install apk_path="/media/apk/X-plore_v.4.49.01.apks" dry_run=true
```

```
Bundle: X-plore_v.4.49.01.apks (12 apk inside)
Device: SDK 28, ABI armeabi-v7a,armeabi, 320 dpi, locale en-US
Chose 3: com.lonelycatgames.Xplore.apk, config.armeabi_v7a.apk, config.xhdpi.apk
  · ABI: armeabi-v7a (device: armeabi-v7a, armeabi)
  · density: xhdpi (320 dpi, exact match)
  · locales: no matching split (device language: en; bundle has: ru) - strings come from the base APK
```

The bundle is unpacked add-on side with Node's own `zlib`, so the device needs nothing. Splits are chosen from device properties read live: `ro.product.cpu.abilist`, `wm density`, `persist.sys.locale`. Three naming conventions are recognised — bundletool (`splits/base-master.apk`, `base-arm64_v8a.apk`), APKMirror-style (`<package>.apk` + `config.arm64_v8a.apk`) and device-pulled (`base.apk` + `split_config.arm64_v8a.apk`).

A wrong ABI is refused; a wrong density is not. An ABI mismatch leaves an app that will not start, so a bundle with no split for any of the device's ABIs is an error and nothing is installed. Density splits fail softly, so the nearest bucket is used and the mismatch is reported. Do not infer the ABI from the SoC or the Android version: Android TV boxes often run a 32-bit userland on 64-bit silicon.

Bundle-only arguments: `dry_run`, `abi`, `density`, `locales`. `locales` adds language splits beyond the device language.

```
adb_install apk_path="/media/apk/X-plore.apks" locales=["ru"]
```

Arrays of individual split paths work unchanged. To restore an app after a factory reset, `pm path <pkg>` on a working device lists the exact split set: `adb_pull` those and pass them back as an array.

## Screenshot geometry and `coords="screenshot"`

`adb_screenshot` downscales its image to `max_px`, so coordinates read off that picture would miss unless rescaled. The tool follows the image with the scale, computed against the *logical* screen size — the one `input tap` and `adb_ui_dump` use, which is `wm size`'s `Override size:` when the device reports one and `Physical size:` otherwise:

```
screen 1920x1080 (frame 3840x2160) -> image 1024x576 · scale 1.875/1.875 · pass coords="screenshot" to adb_tap/adb_swipe
```

`(frame WxH)` appears only when the captured PNG differs from the logical size. Whether it does depends on the device, not on a rule: some boxes with an `Override size:` line capture at the full physical resolution, others already capture at the logical one. Never infer the ratio from the presence of `Override size:` — the tool measures both sizes and compares them.

A screen smaller than `max_px` is not enlarged, because `-resize`'s `>` flag only shrinks; the response is then a plain `scale 1.000/1.000`.

Rotation is judged from the captured frame, which is the source of truth for the current orientation: when the PNG is landscape and `wm size` reports portrait, the logical width and height are swapped.

`wm size` is read fresh on every screenshot, in the same shell call that takes the PNG. A device can switch its physical display mode between two screenshots, so a cached ratio could go stale. If `wm size` cannot be read or parsed, the tool falls back to the frame size and says so in the response:

```
⚠ wm size did not parse, the frame size is used - coordinates may not match input tap
```

If the image geometry itself cannot be read, `coords="screenshot"` is unavailable for that frame and the response says so:

```
frame geometry not determined - use coords="screen" (the default) for adb_tap/adb_swipe
```

Pass `coords="screenshot"` to `adb_tap`/`adb_swipe` to use coordinates read straight off the image. This works only within 120 s of the screenshot and only when `serial` was passed identically to both calls; a screenshot taken without `serial` and a tap with `serial` are different keys, and a stale or missing screenshot is refused:

```
the screenshot is stale or was never taken - call adb_screenshot. Pass serial the same way as in adb_screenshot: a screenshot without serial and a tap with serial are different keys.
```

`coords="screen"` (the default) means coordinates from `adb_ui_dump`, in the same logical space `input tap` uses natively. Rotation *between* the screenshot and the tap is not checked in either mode.

## A near-uniformly dark screenshot

A frame whose mean brightness and standard deviation are both under a small threshold is reported as a warning after the image, not a refusal: a real dark frame is legitimate, and refusing would take the picture away exactly where it is needed. Two optional pieces of evidence are attached when they can be read:

```
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Asleep
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Awake, focused window has FLAG_SECURE, content hidden by the system
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Awake, no protection flag found, the frame may genuinely be black
```

`screen:` comes from `dumpsys power`'s `mWakefulness`. The `FLAG_SECURE` note comes from the focused window's flags in `dumpsys window windows`, filtered on-device so a several-hundred-KB dump never crosses into Node. Either piece is dropped from the text when it cannot be read cleanly; neither is guessed.

On some builds the `FLAG_SECURE` signal is unavailable: `dumpsys window windows` may print no `mCurrentFocus` line at all, and `fl=` values may be printed as a bare number with no `SECURE` token. Both resolve to no note rather than a guess.

If `screencap` returns an empty file instead of a dark frame, the call fails with `screencap produced no data (device asleep or protected content?)` and the same `mWakefulness` reading is appended when it can be read.

## `verify` on `adb_tap`, `adb_swipe`, `adb_key`

`verify: "none"` (default) | `"activity"` | `"ui"` checks whether the action changed anything, instead of a follow-up screenshot.

- `"activity"` compares the resumed activity before and after: `resumed: A -> B`, or `resumed: unchanged (A)`. If the component cannot be determined, the result is `resumed: unknown` rather than a guess.
- `"ui"` does everything `"activity"` does and adds a hash of the UI dump before and after. Matching hashes are retried once after 600 ms, since an animation may still be running, then reported as `ui: changed` or `ui: unchanged`. For `adb_swipe`, `ui: unchanged` is annotated: on a scroll it usually means the end of a list.
- The hash strips every `com.android.systemui` node, so the status-bar clock never counts as a change. Focus and selection are not stripped — for a DPAD key press that is the change being measured.
- A live element outside `com.android.systemui` can still make `"ui"` report `changed` with no action taken: a launcher clock, a player's elapsed-time counter, a self-rotating carousel, a watch-face time node. `ui: unchanged` stays reliable regardless, because it only fires when nothing changed at all.
- `"ui"` costs two to three extra UI dumps, roughly 2–4 seconds. That is why it is off by default.
- A verify failure never turns a performed action into an error. The action has already happened by the time verify runs, so a `uiautomator` failure shows up beside a normal success line:

```
Tapped (240, 262) - from screenshot coordinates (240,262) × 1.000/1.000 · resumed: A -> B · ui: unknown (uiautomator: ERROR: null root node returned by UiTestAutomationBridge)
```

`verify="ui"` uses its own UI dump and never touches the staleness hash `adb_ui_dump` relies on. `adb_find_and_tap` has its own reporting and is not affected by `verify`.

## `adb_find_and_tap`

Finds an on-screen element by `text`, `resource_id` or `desc` and activates it in one call.

```
adb_find_and_tap text="Settings"
adb_find_and_tap resource_id="nav_bar_settings"
adb_find_and_tap text="Apps" exact=true index=1
```

How it activates the element is derived from the device. If `pm list features` reports `android.hardware.touchscreen`, the element centre is tapped. On a leanback device without one, a coordinate tap activates whatever currently has focus instead, so the element is reached by walking the focus with DPAD keys and then pressing `DPAD_CENTER`. `android.hardware.faketouch` does not count as a touchscreen. A device with neither feature is refused:

```
The device reports neither touchscreen nor leanback - there is no known way to activate the element. Refused instead of tapping blind.
```

Nothing is pressed unless the target is actually focused. The UI is re-dumped after every key and the focus is checked. If the focus stops moving, starts cycling between the same nodes, or the target is not reached within `max_steps` or the internal time budget, the response gives the path walked so far and states that nothing was pressed:

```
Focus is cycling: back on "Home", already visited on this walk (UP LEFT RIGHT LEFT). Target "Search" cannot be reached by walking - it is most likely not focusable. Nothing was pressed.
```

Matching rules:

- `text` is checked against both the `text` attribute and `content-desc`. Some TV launchers put every visible label in `content-desc` and leave `text` empty. `desc` stays narrow and matches `content-desc` only.
- A label that is not focusable is raised to the smallest clickable node containing it. TV launchers put the app name in a non-focusable image inside a focusable card, and walking to the label itself would never arrive.
- Several matches without `index` are an error listing the candidates with coordinates, not a guess.
- `max_steps` defaults to 12, maximum 40. Every step re-dumps the UI (~1.5–2 s), and the walk also stops after an internal ~25 s budget so a report comes back instead of a connector timeout.

## `adb_ui_dump`

A compact list of interactive and labelled elements with tap coordinates `@(x,y)`. A stale `uiautomator` cache is detected via a dump hash and the dump is retried once after 600 ms. Password fields are marked `[PASSWORD]` and listed even with no visible text. XML entities in labels are decoded, so a newline in a caption does not arrive as `&#10;`.

## `adb_app` — package operations with guard rails

```
adb_app action=list filter=user q=amazon
adb_app action=protected
adb_app action=disable packages=["com.example.bloat"]          # dry run by default
adb_app action=disable packages=["com.example.bloat"] dry_run=false
adb_app action=restore                                          # undo everything, one call
```

`list`, `info`, `protected` and `state` are read-only. `launch`, `stop` and `clear` act immediately; `clear` defaults to `dry_run: true` because it wipes app data, `stop` does not. `disable`, `uninstall`, `enable`, `restore` and `backup` change state.

### The safety model

- **Everything that changes state defaults to `dry_run: true`.** The plan names the rollback path for each package and lists any advisories. Set `dry_run=false` to apply.
- **The protected set is derived from the device.** Current launcher, active IME, package installer, WebView provider, role holders where the OS exposes them, and account/registration packages. Any overlap aborts the whole call, and there is no override flag:

```
REFUSED: the list contains protected packages - com.example.one, com.example.two.
Protection sources: {"launcher":"..."}
Nothing was applied. Remove them from the list by hand; the tool has no override.
```

- **A package currently serving an off-device client is refused.** This is the network guard, and it covers `disable`, `uninstall`, `stop` and `clear`. The criterion is read off the device: the package holds a listening TCP socket *and* something outside the device is connected to that same port right now (inbound `ESTABLISHED`, non-loopback peer). Both halves matter — a listening socket alone would make every torrent server undisableable, and an `ESTABLISHED` row with a high local port is just an outbound connection the app opened. The refusal names the port and the peer:

```
REFUSED (disable): the package is currently serving a client outside the device.
  · com.example.remote - listening on ports 6466, 6467, currently serving 192.168.1.52 -> :6466
Nothing was applied. Repeat with force_network: true to override; `force` does not lift this guard.
```

  A socket on a shared uid cannot be attributed to one package. It is still refused, with the link stated as unproven rather than waved through.

  Every `dry_run` plan and every applied report carries a `network_guard` object whose `status` is one of three tokens:

| `status` | Meaning |
|---|---|
| `not_serving` | the guard ran and found no off-device client |
| `overridden` | a hit was found and `force_network=true` lifted it; the hits are listed under `overridden` |
| `blind` | `/proc/net` could not be read, so the action ran **without** the network check |

  `blind` is reported rather than silently treated as a pass. The token is unrelated to the `action=clear` value.
- **An account canary runs between batches.** The canary reads the account count and re-resolves the launcher; a drop rolls that batch back and stops. Batch size defaults to 5.
- **Everything applied is written to a snapshot** under `store` (default `/media/adb-mcp/<device>/state.json`), so `action=restore` undoes it in one call.
- **`mode=uninstall` sits behind three locks:** the `allow_uninstall` add-on option (off by default), an explicit `mode` in the call, and a successful APK backup. System packages removed with `--user 0` come back via `cmd package install-existing`; a sideloaded one can only come back from the backup. `force: true` overrides a failed backup and nothing else; it is deliberately not the same flag as `force_network`.

### Other actions

`action=backup` pulls a package's APKs (all splits) plus a `manifest.json` recording version, ABI and the split list. Useful on its own, before a factory reset.

`action=launch` also accepts an intent or deep-link form, which builds `am start -W -a <action> [-d <uri>] [-p <pkg>] [extras...]`:

```
adb_app action=launch intent_action=android.settings.APPLICATION_DETAILS_SETTINGS uri="package:com.lonelycatgames.Xplore"
adb_app action=launch uri="https://example.com/some/deep/link"
```

`intent_action` defaults to `android.intent.action.VIEW` once `uri` is set. `extras` maps `string` to `--es`, `boolean` to `--ez`, an int32-sized integer to `--ei` and a larger integer to `--el`, and refuses anything else by naming the key. `packages` is optional; a single value narrows the resolver via `-p`, more than one is a refusal.

If the intent resolves to a chooser dialog, the tool presses `KEYCODE_BACK` once to close what it opened and reports that several handlers exist. It never presses a second key and never retries.

`intent_action=android.intent.action.CALL`, `CALL_PRIVILEGED` and `CALL_EMERGENCY` are refused while `allow_shell: false`, so a disabled `adb_shell` does not become a side door back to dialling. With `allow_shell: true` there is no refusal, since `adb_shell` can dial anyway.

## `adb_logcat` filter semantics

- **No filter** — the last `lines` raw lines (`logcat -d -t N`).
- **Filterspec** (contains `:` or `*`), e.g. `ActivityManager:I *:S` or `MyTag:D` — applied to the whole buffer on-device, tail on-device. `*:S` is appended automatically when missing, so unmatched tags stay silent.
- **Plain substring**, e.g. `bluetooth` — case-insensitive grep across whole lines, on-device.

Filtering, grep and tail all run on the device, so large log buffers never cross the wire. `lines` defaults to 200 and is capped at 2000.

## Unicode input: ADBKeyBoard

Android's `input text` is ASCII-only. For anything else, `adb_text` routes through the [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) IME: the current keyboard is remembered, switched to AdbIME for the broadcast, and restored afterwards even on failure.

One-time setup per device:

```
adb_push  host_path=/media/.../ADBKeyboard.apk  device_path=/data/local/tmp/ADBKeyboard.apk
adb_shell pm install -r -t -g /data/local/tmp/ADBKeyboard.apk
adb_shell ime enable com.android.adbkeyboard/.AdbIME
```

Without it, non-ASCII input fails with an error carrying these instructions; ASCII always works. `com.android.adbkeyboard` is part of the derived protected set, so `adb_app` will not disable the channel `adb_text` depends on.

## Session and transfer tools

- `adb_devices` lists connected devices with serial, state and description. Start here to get serials.
- `adb_connect` takes `ip` (port 5555 implied) or `ip:port`. A failed connection raises an error rather than returning success text.
- `adb_disconnect` drops one host, or all transports when `host` is omitted.
- `adb_pair` needs the `ip:port` **and** the 6-digit code from the pairing dialog, both random, with the dialog still open.
- `adb_shell` runs any shell command and returns stdout. It is disabled entirely when `allow_shell: false`.
- `adb_uninstall` removes an app by package name; `keep_data=true` passes `-k`.
- `adb_push` and `adb_pull` transfer files and return transfer statistics. The HA side is restricted to `/media` and `/share`.
