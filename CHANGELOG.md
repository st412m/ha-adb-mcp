# Changelog

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
