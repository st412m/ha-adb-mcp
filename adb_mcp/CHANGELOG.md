# Changelog

## 1.3.1 — 2026-09-22

Every string the tools return is English; documentation split into `README.md` + `docs/`.

### Changed
- Tool output, warnings, refusals and error messages are in English; wording changed, behaviour did not.
- Tool and parameter descriptions carry call-time facts only; the rest moved to `docs/`.
- Build-time guard messages in `toolchain-check.sh` are in English.
- `README.md` is a landing page; full tool semantics, configuration notes, troubleshooting and internals live in `docs/`.
- The add-on documentation tab (`DOCS.md`) is an operator manual for a freshly installed add-on and links out for the rest.
- The `adb_app` network-guard status is now `not_serving` / `overridden` / `blind`; `clear` read ambiguously next to the `action=clear` value.

## 1.3.0 — 2026-09-18

Secrets stop reaching the log, screenshots carry their scale, and input tools can verify what they did.

### Added
- `adb_screenshot` reports the logical screen size, the image size and the scale between them; `coords="screenshot"` on `adb_tap`/`adb_swipe` reuses those coordinates within 120 s of the screenshot.
- `verify="activity"|"ui"` on `adb_tap`, `adb_swipe` and `adb_key` reports whether the action changed the resumed activity or the UI dump. A verify failure never turns a performed action into an error.
- A near-uniformly dark screenshot returns a warning naming `mWakefulness` and, where readable, `FLAG_SECURE`, instead of passing as an ordinary frame.
- `adb_app action=launch` accepts `uri`, `intent_action` and `extras` for an intent or deep-link launch.
- `adb_ui_dump` marks `password="true"` nodes `[PASSWORD]` and lists them even with no label of their own.

### Changed
- `intent_action=CALL`, `CALL_PRIVILEGED` and `CALL_EMERGENCY` are refused while `allow_shell: false`.
- `adb_swipe`'s description records that the same start and end point with `duration_ms >= 800` is a long-press.

### Fixed
- With `log_requests: true`, `adb_text` input and `adb_pair` codes reached the tool log and could appear in error text. Both are masked now, and `adb_text` no longer echoes the typed text.
- Screen geometry comes from `wm size` rather than the captured frame, so `coords="screenshot"` lands correctly on devices that capture above their logical resolution.
- `dumpXml()` writes to a randomly named file, closing a race between concurrent dumps.

## 1.2.5 — 2026-09-07

The network signal becomes a refusal instead of a report.

### Added
- A package currently serving an off-device client — a listening TCP socket plus an inbound ESTABLISHED connection to that port from a non-loopback peer — is refused for `disable`, `uninstall`, `stop` and `clear`, naming the port and the peer.
- `force_network: true` lifts that guard and nothing else; it does not lift the protected set.
- A guard that cannot read `/proc/net` reports itself as blind in the output instead of proceeding as if the check had passed.

### Changed
- `stop` and `clear` are covered by a guard for the first time; they previously consulted nothing.
- A listening socket on a shared uid is refused with the attribution stated as unproven, instead of being passed over.
- `CHANGELOG.md` moved into `adb_mcp/` and `adb_mcp/DOCS.md` was added, so Home Assistant can show both from the add-on's own tabs.

## 1.2.4 — 2026-08-09

One fix found while accepting 1.2.3 on hardware.

- A launch is confirmed against the resumed activity, with `mCurrentFocus` kept as a second opinion; the old check warned on firmware that reports `mCurrentFocus=null` while the app is alive.
- The warning states what is on top instead of blaming timing.

## 1.2.3

Fixes from acceptance across five devices.

### Fixed
- `action=launch` tries `monkey` with `LAUNCHER` and `LEANBACK_LAUNCHER`, then `resolve-activity` against `MAIN` with each category and bare `MAIN`. When nothing resolves, the error lists every attempt.
- A resolved activity belonging to another package — the system chooser — is discarded instead of being started and reported as a launch.
- A listening socket is no longer attributed to every package sharing its uid; a uid spread across more than three packages, or owning none, is reported under `net_unattributed`.
- An absent subsystem reads differently from a failed probe, so a device with no WebView provider no longer looks like a fault.
- XML entities in `uiautomator` labels are decoded, so a newline no longer arrives as `&#10;`.
- Duplicate labels collapse by label alone, keeping the variant that carries a resource-id.

## 1.2.2

Follow-up to the 1.2.1 acceptance run.

- Duplicate labels in the "visible now" list are collapsed to one entry.
- A container and the label inside it no longer count as two matches, so `index` is not demanded where there is nothing to choose between.

## 1.2.1

Fixes from the 1.2.0 acceptance run on three live devices.

### Fixed
- `text` is matched against `content-desc` as well as the `text` attribute, so a label that exists only in `content-desc` is findable.
- A non-focusable label is raised to the smallest clickable node containing it, which is the node the DPAD walk can actually reach.
- Node identity includes the label recovered from child nodes, so app cards with no text of their own are told apart.
- Cycling focus is detected and aborts with a report; previously only a fully stopped focus was caught.
- The DPAD walk is bounded by an internal ~25 s budget as well as `max_steps`, whose default drops from 20 to 12.
- Failure reports name the focused element instead of an empty string.
- `adb_app action=launch` confirms a launch by `Events injected`, with a `resolve-activity` fallback that starts the main activity explicitly.
- An ABI refusal names the ABI that was actually requested.

## 1.2.0

Two features unblocked by the 1.1.1 property fixes. Tools 17 -> 18.

### Added
- New tool `adb_find_and_tap`: finds an element by text, resource-id or content-desc and activates it. The method is read from `pm list features` — tap with a touchscreen, walk the focus with DPAD keys without one.
- `adb_find_and_tap` re-dumps the UI after every key and presses nothing when the focus stalls or the target is not reached within `max_steps`.
- `adb_install` accepts a single `.apks`/`.xapk`/`.apkm` bundle and picks splits from the device ABI list, screen density and locale. The bundle is unpacked add-on side with Node's own `zlib`, so the device needs nothing.
- Three split naming conventions are recognised: bundletool, APKMirror-style and device-pulled.
- No matching ABI split is a refusal; a density mismatch uses the nearest bucket and is reported. `locales` adds language splits, `dry_run` reports the selection without installing.

## 1.1.2

Two derived signals added to the protected set. No GitHub release; a staging build.

### Added
- `net_listener` — packages holding a listening TCP socket, read from `/proc/net/tcp` and `/proc/net/tcp6` with uid mapped to package via `pm list packages -U`.
- `authenticator` — packages that register an account authenticator, parsed from the `AuthenticatorDescription` lines of `dumpsys account`.

### Changed
- Protect or warn is decided by reversibility: a system package carrying either signal joins the protected set, a user package produces a warning in the plan instead of a refusal.
- The name-based account heuristic is demoted to a supplementary source.

## 1.1.1

Acceptance of 1.1.0 on three live devices found six defects, two of them silent. No GitHub release; a staging build.

### Fixed
- Role holders are read from `dumpsys role`. `cmd role get-role-holders` does not exist, so the role tier had never worked on any device, and its failure looked exactly like a platform without roles.
- The package installer is resolved with `content://` first and `file://` as a fallback, and every derived source is validated against a package-name pattern before it is trusted.
- A source that fails to answer always leaves a note, so an absent platform feature and a failed probe are no longer indistinguishable.
- `locale` is parsed on markers and validated as BCP-47, with a fallback chain starting at `persist.sys.locale`; it previously came back as the literal string `#model` on firmware with an empty `ro.product.locale`.
- Physical and override screen density are captured separately, the override wins when present, and a mismatch is reported.
- `versionName` is no longer empty in `action=info`, in `backup` output and in `manifest.json`.

### Added
- `manifest.json` records the device ABI list alongside model, SDK, density and locale.

## 1.1.0 — 2026-08-07

New tool `adb_app`, and the server split into modules. Tools 16 -> 17.

### Added
- New tool `adb_app` with actions `list`, `info`, `protected`, `launch`, `stop`, `clear`, `disable`, `uninstall`, `enable`, `restore`, `backup`, `state`.
- The protected set is derived from the device — launcher, package installer, active IME, WebView provider, role holders, account packages — and any overlap aborts the whole call.
- An account canary between batches re-checks the account count and launcher resolution; a drop rolls that batch back and stops.
- A snapshot on the HA filesystem records everything applied, so `action=restore` undoes it in one call.
- APK backup pulls every split plus a `manifest.json`; restore reuses `install-multiple`.
- `mode=uninstall` is gated three ways: the new `allow_uninstall` option (default `false`), an explicit `mode` in the call, and a successful APK backup.
- Everything that changes state defaults to `dry_run: true` and returns the full plan, including which packages are protected and why.

### Changed
- The server is split into modules (`adb`, `device`, `session`, `ui`, `files`, `apps`, `registry`); `server.js` is transport only.
- `toolchain-check.sh` verifies that every module is present in the image, parses, and that the whole `require` graph loads with a non-empty tool registry.

## 1.0.0 — 2026-07-28

First stable release. No code changes over 0.5.1.

### Added
- `LICENSE` file (MIT).
- README sections on the official MCP Server integration, known limitations, split-APK usage, and an explicit warning about irreversible ADB operations.

## 0.5.1 — 2026-07-28

### Fixed
- `install-multiple` was unreachable from MCP clients that serialise array parameters as JSON strings: the whole array arrived as one string and failed path validation. Arrays are now coerced.
- `INSTALL_FAILED_VERIFICATION_FAILURE` carries the setting that fixes it.

## 0.5.0

### Added
- `adb_install`: `apk_path` accepts an array of paths and installs split APKs atomically via `install-multiple`. A single path string behaves exactly as before. Choosing the right splits is up to the caller.

## 0.4.1

### Changed
- `armv7` dropped from the supported architectures after Supervisor deprecated it. No functional changes.

## 0.4.0

### Changed
- Base image moved to the arch-less multi-arch manifest `ghcr.io/home-assistant/base:3.22`, so a wrong default can no longer pull an amd64 base on ARM.
- Toolchain on 3.22: nodejs 22.23.0, android-tools 35.0.2, ImageMagick 7.1.2.15. Same majors, so the build-time guard and the screenshot smoke are unchanged.

## 0.3.8 — 2026-07-21

No release notes were kept for this version.

## 0.3.7 — 2026-07-21

No release notes were kept for this version.

## 0.3.6 — 2026-07-21

The screenshot pipeline moves to file-to-file, ending the 0.3.3-0.3.5 breakage.

### Fixed
- The screenshot pipeline is `adb exec-out > tmp`, then ImageMagick file to file, then `cat`. It replaces the `adb exec-out | magick png:- ... jpg:-` form that broke 0.3.3-0.3.5.
- Buffering the PNG in Node leaked roughly 3 MB per frame, found in a soak run over 19-21 July.

## 0.3.5 — 2026-07-21

⚠️ Broken release: one of three consecutive releases broken in production on this date.

- The streaming ImageMagick form (`adb exec-out | magick png:- ... jpg:-`) silently returned 0 bytes with exit code 0 on the production image; the failure came from the behaviour of external utilities, not from the code.
- Toolchain versions were recorded nowhere, so the failure could not be diagnosed from the log.
- Fixed in 0.3.6.

## 0.3.4 — 2026-07-21

⚠️ Broken release: one of three consecutive releases broken in production on this date.

- The streaming ImageMagick form (`adb exec-out | magick png:- ... jpg:-`) silently returned 0 bytes with exit code 0 on the production image; the failure came from the behaviour of external utilities, not from the code.
- Toolchain versions were recorded nowhere, so the failure could not be diagnosed from the log.
- Fixed in 0.3.6.

## 0.3.3 — 2026-07-21

⚠️ Broken release: one of three consecutive releases broken in production on this date.

- The streaming ImageMagick form (`adb exec-out | magick png:- ... jpg:-`) silently returned 0 bytes with exit code 0 on the production image; the failure came from the behaviour of external utilities, not from the code.
- Toolchain versions were recorded nowhere, so the failure could not be diagnosed from the log.
- Fixed in 0.3.6.

## 0.3.2 — 2026-07-19

### Fixed
- `adb_logcat` substring mode matched every line after binary bytes in the crash buffer on firmware shipping BSD grep as `/system/bin/grep`; `toybox grep` is preferred when available.
- `adb_logcat` substring mode returns `(empty)` on zero matches instead of an error.
- The adb wrapper no longer discards stdout on a non-zero exit, so a failed shell pipeline shows the command output in the error message.

## 0.3.1 — 2026-07-19

### Changed
- Common adb errors (`device not found`, `device offline`, `unauthorized`) carry the action that fixes them.
- `adb_connect` failures raise an error instead of returning success text.
- README rewritten to cover the whole tool set; `CHANGELOG.md` added.

## 0.3.0 — 2026-07-19

### Added
- `adb_text`: Unicode input (Cyrillic, emoji, CJK) via ADBKeyBoard, with an automatic IME switch and restore and a setup error when the keyboard is missing.
- `adb_screenshot`: optional `max_px` and `quality` parameters.

### Changed
- `adb_screenshot` defaults tightened to 1024 px and quality 70.

## 0.2.2 — 2026-07-18

### Changed
- `adb_logcat` filtering, grep and tail moved on-device, fixing host-side `maxBuffer` overflow on large buffers. Filterspec auto-appends `*:S`; substring mode is case-insensitive.

### Added
- Tool-call logging under the existing `log_requests` flag: tool name, arguments, duration, response size or error.

## 0.2.1 — 2026-07-18

### Fixed
- `adb_logcat`: `filter` windowed the raw buffer before filtering, and substring mode did nothing.
- `adb_ui_dump`: a stale `uiautomator` cache is detected by dump hash and retried after 600 ms; `uiautomator` errors are no longer swallowed.
- `run.sh` no longer hardcodes the version in its banner.

### Added
- `adb_install`: `-t` flag, so testOnly and debug builds install.
- `adb_push` and `adb_pull` return transfer statistics.

## 0.2.0 — 2026-07-18

Pairing support for Android 11+.

### Added
- `adb_pair` for Wireless Debugging with a pairing code.

### Fixed
- Stale VERSION banner.

## 0.1.1

- adb server startup uses `adb -a server nodaemon` instead of `ADB_SERVER_SOCKET`.

## 0.1.0

First release: the initial ADB tool set, MCP Streamable HTTP transport, auth proxy.
