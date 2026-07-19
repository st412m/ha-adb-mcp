# Changelog

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
