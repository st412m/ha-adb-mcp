# Internals

How the add-on is arranged inside the image, how a tool reaches its implementation, and which parts of the arrangement break silently when they are not kept in step.

## Processes

`run.sh` starts three things, in order:

1. `/toolchain-check.sh runtime` — prints the toolchain banner into the add-on log.
2. `adb -a -P 5037 server nodaemon` — the classic adb server, listening on all interfaces.
3. `node /server.js 3199` — the MCP server, and then `node /proxy.js` in the foreground, which serves port 3200 and checks the secret path prefix.

## Modules

Every file is copied to the image root, so a module is required as `/name.js`.

| Module | Responsibility |
|---|---|
| `proxy.js` | auth proxy on port 3200: secret path prefix, optional HTTP access log |
| `server.js` | MCP Streamable HTTP transport, argument masking and error redaction for the tool log |
| `registry.js` | tool schemas (`tools/list`) and the `tools/call` dispatcher |
| `adb.js` | the `adb` binary wrapper: timeouts, error rewriting, device-shell quoting, host-path validation, argument coercion |
| `device.js` | facts read off the device: properties, package lists, accounts, roles, listening sockets, authenticators, the derived protected set, the resumed activity |
| `session.js` | adb session and diagnostics: `devices`, `connect`, `pair`, `disconnect`, `shell`, `logcat` |
| `ui.js` | screen and input: screenshot pipeline, UI dump, tap, swipe, key, text, find-and-tap |
| `files.js` | APK install and uninstall, `.apks` bundle handling, push and pull |
| `apps.js` | `adb_app`: package operations, dry runs, the network guard, the account canary, snapshots and rollback |

The transport knows nothing about the tools, and the tool modules know nothing about JSON-RPC. `device.js` is where anything shared between `apps.js` and `ui.js` lives, so those two never require each other.

## Registering a tool

A tool is one entry in the `TOOLS` array in `registry.js` — `name`, `description`, `inputSchema` — plus one `case` in `callTool` that forwards to the implementing module. Both halves are required: an entry with no `case` fails at call time with `Unknown tool: <name>`, and a `case` with no entry is invisible to `tools/list`.

`inputSchema` descriptions are the only instruction manual the calling agent gets. Anything true but not needed to make the call belongs in [tools.md](tools.md), not in the schema.

## Traps

**A forgotten `COPY` line builds cleanly and dies at runtime.** Files are copied into the image one by one, so a new module that is not listed in `Dockerfile` is simply absent. The same module list is duplicated in `toolchain-check.sh`, which at build time checks that every file exists, parses, and that requiring `/registry.js` pulls in the whole graph and yields a non-empty registry. Adding a module means editing both lists.

**A pinned toolchain.** `toolchain-check.sh` fails the build when the major version of nodejs, android-tools or ImageMagick moves away from `EXPECT_*_MAJOR`. Patch releases inside a branch are allowed. After confirming `adb_screenshot` still works by hand, update the constants.

**The screenshot pipeline is file-to-file, deliberately.** `adb exec-out screencap -p > tmp` then ImageMagick file to file, then `cat`. The streaming form (`magick png:- ... jpg:-` with a pipe on stdin) is checked at build time for the record only and is not used by the code.

**The build smoke calls the real function.** The screenshot geometry check in `toolchain-check.sh` imports `buildImagePipeline` and `parseGeometry` from `/ui.js` rather than keeping its own copy of the ImageMagick command; a copy would test a duplicate instead of the code `adb_screenshot` runs.

**Client argument coercion.** Some MCP clients serialise array and object parameters as JSON strings. `coerceArray`, `coerceBool` and `coerceObject` in `adb.js` accept both shapes. A new array or object parameter that reads `args.x` directly will fail on those clients with a type error that looks like a user mistake.

**`adbSh` is tolerant by default.** It appends `; :` to the device command, because otherwise the last command of a pipeline sets the exit code and a `grep` with no matches (exit 1) fails the whole call. Pass `tolerant: false` only when the exit code is the answer.

**Derived over hardcoded.** The protected set, the input mode of `adb_find_and_tap` and the split selection in `adb_install` are all read off the device. A list of package names or model names in the code would be correct only for the devices it was written against.

**Comments are in Russian.** They are the project's design record. Code, strings and documentation are in English.
