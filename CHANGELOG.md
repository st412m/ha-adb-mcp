# Changelog

## 1.2.0
Two features that were blocked until the 1.1.1 property fixes landed — split selection reads the device locale and density, and both were wrong before.

**`.apks` bundle install.** `adb_install` now accepts a single `.apks` / `.xapk` / `.apkm` bundle and picks the splits from the device's actual ABI list, screen density and locale. The prompt for this was the Fire TV rebuild after the July factory reset, where X-plore had to go in by hand through `pm install-create` / `install-write` / `install-commit` because `adb install` rejects a bundle and Fire OS 7 has no `unzip` to unpack one on the device. Unpacking happens add-on side instead, so the device needs nothing.

- **The ZIP reader is written against `zlib`, not shelled out to `unzip`.** The container installs only nodejs, android-tools and imagemagick — there is no `unzip` in it. Alpine's busybox has an applet, but relying on that is a guess and adding a package for one operation is worse; a `.apks` is an ordinary ZIP and Node already ships `zlib`. No new dependency. Verified byte-for-byte against a reference implementation on deflate, stored, and archives with a trailing comment.
- **Three naming conventions are supported, not one.** bundletool writes `splits/base-master.apk` and `base-arm64_v8a.apk`; APKMirror-style bundles use `<package>.apk` plus `config.arm64_v8a.apk`; pulling an installed app off a device gives `base.apk` plus `split_config.arm64_v8a.apk`. Supporting only the convention the code was written against would mean it works on exactly the bundles used to test it.
- **A wrong ABI is refused; a wrong density is not.** An ABI mismatch leaves an app that will not start, so a bundle with no split for any of the device's ABIs is an error and nothing is installed. Density splits fail softly — resources fall back to the base APK — which is not a guess: on the Fire TV, X-plore is running right now with a `tvdpi` split on an `xhdpi` device. The nearest bucket is used and the mismatch is reported.
- Language splits follow the device locale, with a `locales` argument to add more (useful when the system language and the user's language differ). `dry_run` reports the selection without installing.

**`adb_find_and_tap`.** Finds an element by text, resource-id or content-desc and activates it in one call.

The interesting part is how it activates. A coordinate tap on a TV box does not land where the coordinates point — it activates whatever currently holds focus, so the tap silently does the wrong thing. That behaviour was recorded as a Fire TV quirk; checking `pm list features` on all three boxes showed it is not device-specific at all: **none of them reports `android.hardware.touchscreen`**, they are all `leanback_only`. So the mode is derived from the feature list rather than from a model name: with a touchscreen, tap the element centre; without one, walk the focus to the element with DPAD keys and press DPAD_CENTER.

Nothing is assumed to have worked. The UI is re-dumped after every key press and the focus is re-checked; the target is re-located each step because scrolling moves it. If the focus stops responding on both axes, or the target is not reached within `max_steps`, the tool says exactly where it stopped and presses **nothing** — a silent miss on someone's television is a worse outcome than a clear refusal.

## 1.1.2
Two new **derived** signals for the protected set, replacing what would otherwise have been a hardcoded package name.

The prompt for this was a hole left over from 1.1.1: reading role holders from `dumpsys role` protects the Google TV remote service on Android 12, but the `SYSTEM_TELEVISION_REMOTE_SERVICE` role does not exist before SDK 31 — so on an Android 11 box the very same package sits unprotected. Adding that one package to the core list would have fixed exactly one device and left every other vendor's equivalent exposed. The generalisation comes from restating the problem: **a latent failure is a failure visible only from outside the device**, and the canary only ever looks inward. So the thing worth detecting is external coupling.

- **`net_listener`** — packages holding a listening TCP socket, read from `/proc/net/tcp` and `/proc/net/tcp6` with uid mapped to package via `pm list packages -U`. A listening socket is direct evidence that a package serves something beyond itself, and it requires no knowledge of the vendor or of any package name. One distinction carries the whole signal: an ESTABLISHED row with a high local port is an *outbound* connection and means nothing — any VPN client or video player produces dozens. Only LISTEN counts, and an inbound connection to a listening port from a non-loopback peer escalates it to "currently serving an off-device client". Verified readable from the shell on SDK 28, 30 and 31; the Android 10+ restrictions on `/proc/net` do not apply to uid 2000.
- **`authenticator`** — packages that actually register an account authenticator, parsed from the `AuthenticatorDescription {type=...}, ComponentInfo{package/...}` lines of `dumpsys account`. This is derivation in place of guessing: the previous account-stack detection matched package names against a list of regexes, which is the same hardcoding in a different shape. The name-based heuristic is kept, but demoted to a supplementary source — it still catches support libraries that register no authenticator of their own.

**Protect or warn is decided by reversibility, not by importance.** A *system* package carrying either signal goes into the protected set: it is hard to restore and its loss is hard to notice. A *user* package carrying the same signal produces a warning in the plan instead of a refusal, because the add-on can back up and reinstall its APK. Without that line the socket signal would make every torrent server and VPN client undisableable, and the authenticator signal would do the same to file managers, which register authenticators too. Warnings appear in the `dry_run` plan per package, and in the report when a run proceeds.

No GitHub release is cut for this version either; it is a staging build on the way to the next feature release.

## 1.1.1
Acceptance of 1.1.0 on the three live devices (Fire TV / SDK 28, Shield / SDK 30, TiVo / SDK 31) found four defects. Two of them were in the protected set itself, and both failed **silently** — which is the part that matters. 1.1.0 had only ever been exercised against a stubbed `adb`, and a stub cannot tell you that a real command does not exist.

- **Role tier never worked, on any device.** `cmd role get-role-holders` does not exist: the role service has `add-role-holder`, `remove-role-holder` and `clear-role-holders`, but **no getter at all**. The tier was designed around a command that was never there, and because the output filter discarded `Unknown command: ...` as "not a package name", the failure looked exactly like "this platform has no roles". Role holders are now read from `dumpsys role`. Concretely, this closes a live hole: `com.google.android.tv.remote.service` (role `SYSTEM_TELEVISION_REMOTE_SERVICE`) was not protected, and disabling it would have silently killed the `androidtv_remote` integration for both Google TV boxes — a failure the account canary cannot see, because the Google accounts stay right where they are.
- **Package installer was never derived on Android 10+.** `resolve-activity` was called with `-d file:///x.apk`, which SDK 29+ refuses to resolve for an install intent. Worse than the miss: the literal reply `No activity found` was inserted into the protected package list as if it were a package name, because the result was not validated. Resolution now tries `content://` first and falls back to `file://` for older builds, and **every** derived source is checked against a package-name pattern before it is trusted.
- **A source that fails to answer now always leaves a note.** Previously a failed probe and a genuinely absent platform feature produced the same (empty) output, so a gap in the protection was invisible in the result. "No role service on this platform (SDK < 29)" and "`dumpsys role` failed, ROLES NOT COVERED" are now different, and loud.
- **`locale` was garbage on Fire OS 7.** `ro.product.locale` is empty there, and the marker-based output parser had a greedy-whitespace bug that made the field swallow the *next* marker — the reported locale was the literal string `#model`. Property output is now split on markers so an empty value is unambiguous, the locale is taken from a fallback chain (`persist.sys.locale` first, since that is the locale apps actually run in) and validated as BCP-47. This was a blocker for split selection, not a cosmetic issue.
- **Screen density is now read unambiguously.** `wm density` prints a physical density and, when set, an override; the old parser took the last line and so could not tell them apart. Both are captured, the override wins when present, and a mismatch is reported.
- **`versionName` was always empty** — in `action=info`, in `backup` output, and in `manifest.json`, which is the one document a deleted app is restored from. Cause: `grep -m2` stopped after two matching lines, and `primaryCpuAbi=` and `versionCode=` come first in `dumpsys package`, so the name was cut off before it appeared.
- `manifest.json` now records the device ABI list alongside model, SDK, density and locale.

No GitHub release is cut for this version; it is a staging build on the way to the next feature release.

## 1.1.0
- **New tool `adb_app` — package operations with guard rails.** Actions: `list`, `info`, `protected`, `launch`, `stop`, `clear`, `disable`, `uninstall`, `enable`, `restore`, `backup`, `state`. It exists because debloating a Fire TV by hand through `adb_shell` cost one device: 22 packages were disabled from a public "safe list", the box silently lost its Amazon account registration, re-login hung hard, and only a factory reset brought it back
- The **protected set is derived from the device**, not hardcoded: current launcher and package installer (`cmd package resolve-activity`), active IME (`settings get secure default_input_method`), WebView provider (`dumpsys webviewupdate`), role holders where the OS has them, plus account/registration packages. Any overlap with the requested list **aborts the entire call** — no partial application. On the Fire TV that broke, this set automatically covers `com.amazon.tv.ottssocompanionapp`, the OTT single-sign-on package that a name-based safe list would never flag
- **Account canary between batches.** Losing device registration is a *latent* failure: the system still boots and apps still run, so a reboot check says everything is fine. `adb_app` snapshots the account count (`dumpsys account`, counts and types only — never account names) before starting and re-checks it after every batch, together with launcher resolution. A drop rolls the batch back and stops
- **Snapshot on the HA filesystem** (`/media/adb-mcp/<device>/state.json` by default, `store` overrides): everything applied is recorded, so `action=restore` undoes it in one call. `disable-user` was always reversible in principle — what was missing in July was a list to reverse *from*
- **APK backup** (`action=backup`, and automatically before `uninstall`): `pm path` → pull every split → `<store>/<device>/apk/<pkg>/<versionCode>/` with a `manifest.json`. Without a store account you cannot re-download anything, so a local copy is the only way back. Restore reuses `install-multiple`
- `mode=uninstall` is available but gated three ways: the new addon option `allow_uninstall` (default `false`), an explicit `mode` in the call, and a successful APK backup (`force` to override). System packages removed with `--user 0` come back via `cmd package install-existing`; sideloaded ones only from the backup
- Everything that changes state defaults to `dry_run: true` and returns the full plan, including which packages are protected and why
- **Server split into modules** (`adb`, `device`, `session`, `ui`, `files`, `apps`, `registry`), `server.js` is now transport only. Done before the new features rather than after — the 700-line monolith would have survived one more tool, not three
- Build guard extended: `toolchain-check.sh` now verifies every module is present in the image, parses, and that the whole `require` graph loads with a non-empty tool registry. Files are copied into the image one by one, so a forgotten `COPY` line would otherwise produce an image that builds cleanly and dies at runtime

## 1.0.0
- **First stable release.** No code changes over 0.5.1 — the bump marks the end of the soak programme that started at 0.3.2
- Memory: the screenshot leak found in 0.3.2 (~3.1 MB retained per frame, ratchet pattern) was fixed in 0.3.6 by moving the pipeline to file→file, and has now been re-verified on 0.5.1. Final gate: 3 series × 8 `adb_screenshot` (320 px / q30) with 10 min idle after the first series — RSS 32.5 → 34.5 MB, per-series deltas decaying +1.41 → +0.40 → +0.14 MB. That is a plateau, not a ratchet; the same 24 frames on 0.3.2 would have added roughly 75 MB. CPU returned to 0.0 at every measurement
- aarch64 is now **confirmed**, not best-effort: an external tester built and ran the addon on a Raspberry Pi 4 (HAOS bare metal) — clean build, clean start, all three screenshot-pipeline smokes pass. ADB tools themselves remain untested on ARM (no Android device on that setup)
- README: added "Why not the official MCP Server integration?", a known-limitations section, split-APK usage, and an explicit warning about irreversible ADB operations. `LICENSE` file added (MIT — the README already claimed it)

## 0.5.1
- `adb_install`: fixed `install-multiple` being unreachable from web and desktop MCP clients. Those clients serialize array parameters as JSON strings, and the handler only checked `Array.isArray()`, so the whole array arrived as a single string and failed path validation with `Access denied (host path outside /media, /share)`. Arrays are now coerced (array → as-is, `"[...]"` → parsed, anything else → single-element). Same class of bug as ha-filesystem-mcp issue #2
- `INSTALL_FAILED_VERIFICATION_FAILURE` now carries a hint: the on-device package verifier rejects ADB installs, disable it once with `settings put global verifier_verify_adb_installs 0`. Seen on certified Android TV devices with Play Services; devices without Play Protect (e.g. Fire OS) are unaffected regardless of the setting

## 0.5.0
- `adb_install`: `apk_path` accepts an **array** of paths → `adb install-multiple`, i.e. atomic installation of split APKs (base + `config.*`). Restoring an app after a factory reset becomes `pm path <pkg>` → `adb_pull` → pass the set back as an array. Choosing the right splits by ABI (`ro.product.cpu.abilist`) and density (`wm density`) is up to the caller — no bundletool in the container
- A single path string keeps working exactly as before (`adb install`)

## 0.4.1
- Dropped `armv7` from supported architectures — Home Assistant Supervisor has deprecated it (`App config 'arch' uses deprecated values ['armv7']` warning on every install). No functional changes

## 0.4.0
- Base image migrated to the arch-less multi-arch manifest `ghcr.io/home-assistant/base:3.22` (was `${BUILD_ARCH}-base:3.21`, which is out of the docker-base support window). No `BUILD_ARCH` substitution: buildx resolves the manifest by `--platform`, so a wrong default can no longer silently pull an amd64 base on ARM
- Toolchain on 3.22 (verified against aports): nodejs 22.23.0, android-tools 35.0.2, ImageMagick 7.1.2.15. Same majors — build-time guard and screenshot-pipeline smoke unchanged
- No code changes; the screenshot pipeline remains file→file only

## 0.3.2
- `adb_logcat` substring mode: fixed false matches on Fire OS — Amazon ships BSD grep 2.5.1-FreeBSD as `/system/bin/grep`, which matches *every* line after binary bytes in the logcat crash buffer (`-a` and `LC_ALL=C` don't help). The filter now prefers `toybox grep` when available (stock Android grep *is* toybox — no behavior change there)
- `adb_logcat` substring mode: zero matches now return `(empty)` instead of an error
- adb wrapper: stdout is no longer discarded on non-zero exit — shell pipeline failures now show the command output in the error message

## 0.3.1
- Common adb errors (`device not found`, `device offline`, `unauthorized`) now carry actionable hints
- `adb_connect` failures (`failed to connect`, host unreachable) raise a proper error instead of returning success text
- README rewritten for the full 16-tool set; CHANGELOG added

## 0.3.0
- `adb_text`: Unicode input (Cyrillic/emoji/CJK) via ADBKeyBoard — automatic IME switch and restore, clear error with setup instructions when the keyboard is missing
- `adb_screenshot`: defaults tightened to 1024px / quality 70; new optional `max_px` and `quality` parameters

## 0.2.2
- `adb_logcat`: filtering, grep and tail moved **on-device** — fixes host-side `maxBuffer` overflow on large buffers; filterspec auto-appends `*:S`; substring mode implemented (case-insensitive)
- Tool-call logging under the existing `log_requests` flag (tool name, args, duration, response size / error)

## 0.2.1
- `adb_logcat`: fixed broken `filter` (was windowing the raw buffer before filtering; substring mode was a no-op)
- `adb_ui_dump`: stale uiautomator cache detected via dump hash, auto-retry after 600 ms; uiautomator errors no longer swallowed
- `adb_install`: `-t` flag — testOnly/debug builds install
- `adb_push` / `adb_pull`: transfer stats returned (adb writes them to stderr without a TTY)
- `run.sh` banner no longer hardcodes the version

## 0.2.0
- `adb_pair` tool for Android 11+ Wireless Debugging (pairing code)
- Fixed stale VERSION banner

## 0.1.1
- Fixed adb server startup (`adb -a server nodaemon` instead of `ADB_SERVER_SOCKET`)

## 0.1.0
- Initial release: 13 ADB tools, MCP Streamable HTTP, auth proxy
