'use strict';
/**
 * registry.js — схемы инструментов (tools/list) и диспетчер tools/call.
 *
 * Реестр отделён от транспорта намеренно: server.js теперь ничего не знает
 * про сами инструменты, а модули не знают про JSON-RPC.
 */

const session = require('./session.js');
const ui = require('./ui.js');
const files = require('./files.js');
const apps = require('./apps.js');

const TOOLS = [
  {
    name: 'adb_devices',
    description: 'List connected Android devices with serial, state and description. Start here to get serials for other tools.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'adb_connect',
    description: 'Connect to a device over network ADB. host is ip or ip:port (default port 5555).',
    inputSchema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] }
  },
  {
    name: 'adb_pair',
    description: 'Pair with an Android 11+ device over Wireless Debugging. On the device: Developer options -> Wireless debugging -> "Pair device with pairing code" shows ip:port and a 6-digit code. The pairing port is random and differs from the connect port; after pairing succeeds, call adb_connect with the ip:port shown on the main Wireless debugging screen.',
    inputSchema: { type: 'object', properties: {
      host: { type: 'string', description: 'ip:port from the pairing dialog (random port, NOT 5555)' },
      code: { type: 'string', description: '6-digit pairing code from the dialog' }
    }, required: ['host', 'code'] }
  },
  {
    name: 'adb_disconnect',
    description: 'Disconnect a network ADB device. Omit host to disconnect all.',
    inputSchema: { type: 'object', properties: { host: { type: 'string' } } }
  },
  {
    name: 'adb_shell',
    description: 'Run a shell command on the device (settings, pm, am, dumpsys, getprop, wm, cmd, svc...). Returns stdout. serial optional when a single device is connected.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, serial: { type: 'string' }, timeout_sec: { type: 'number' } }, required: ['command'] }
  },
  {
    name: 'adb_screenshot',
    description: 'Take a screenshot of the device screen. Returns a JPEG image so Claude can see the UI, followed by a text line with the screen size, the image size and the scale between them, e.g. "screen 1080x2340 -> image 473x1024 · scale 2.283/2.285" — pass coords="screenshot" to adb_tap/adb_swipe to tap using coordinates read off THIS image directly. Downscaled to max_px (default 1024) at JPEG quality (default 70); raise them only when fine detail matters. A near-uniformly dark frame is reported as a warning after the image, not refused — it can be a genuinely dark scene, a sleeping screen or FLAG_SECURE content, and the warning says which evidence (if any) could be read off the device.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' }, quality: { type: 'number', description: 'JPEG quality 30-95, default 70' }, max_px: { type: 'number', description: 'Max dimension 320-1920, default 1024' } } }
  },
  {
    name: 'adb_ui_dump',
    description: 'Dump the current UI hierarchy (uiautomator) as a compact list of interactive/labeled elements with tap coordinates @(x,y). Password fields are marked [PASSWORD] and listed even with no visible text. Use together with adb_tap.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' } } }
  },
  {
    name: 'adb_tap',
    description: 'Tap at coordinates (x, y). coords="screen" (default) means coordinates from adb_ui_dump — the LOGICAL screen size (wm size Override if the device has one, otherwise Physical), which is the same space input tap itself uses. coords="screenshot" means coordinates read directly off the last adb_screenshot image for the SAME serial (pass serial the same way in both calls) — they are rescaled automatically to that same logical space, but only within 120s of that screenshot; older or missing screenshots are refused rather than guessed. On some TV boxes (seen on Shield and Fire TV) the screenshot frame is captured at a higher physical resolution than the logical one input tap/uiautomator operate in — this is accounted for automatically, you never need to think about it. Rotation between the screenshot and the tap is not checked. verify="activity"|"ui" checks whether the tap actually changed anything (resumed activity, and optionally a UI dump hash) — off by default, since it adds latency; "ui" costs two-three extra UI dumps (~2-4s). A verify failure never turns a performed tap into an error.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' }, serial: { type: 'string' },
      coords: { type: 'string', enum: ['screen', 'screenshot'], description: 'Coordinate space, default "screen". "screenshot" = pixels read off the last adb_screenshot image for this serial, rescaled automatically; refused if that screenshot is missing or older than 120s.' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'Default "none". "activity": compares the resumed activity before/after. "ui": also hashes the UI dump before/after (adds ~2-4s); a live element outside com.android.systemui — a player\'s elapsed-time counter, a launcher clock, an auto-rotating carousel — can produce a false "changed" (confirmed live: a YouTube timer ticking over alone triggered it, with no actual action taken). "unchanged" stays reliable regardless.' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'adb_swipe',
    description: 'Swipe from (x1,y1) to (x2,y2) over duration_ms (default 300). The same point on both ends with duration_ms >= 800 is a long-press. coords and verify work the same as in adb_tap (both endpoints share the same coordinate space); with verify="ui", an "unchanged" result on a swipe usually means the end of a scrollable list.',
    inputSchema: { type: 'object', properties: {
      x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'number' }, serial: { type: 'string' },
      coords: { type: 'string', enum: ['screen', 'screenshot'], description: 'Coordinate space for BOTH endpoints, default "screen". See adb_tap for the "screenshot" semantics and its 120s TTL.' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'See adb_tap. For a swipe, "ui" reporting "unchanged" usually means you hit the end of a scrollable list rather than that nothing happened.' },
    }, required: ['x1', 'y1', 'x2', 'y2'] }
  },
  {
    name: 'adb_text',
    description: 'Type text into the focused input field. ASCII goes through input text; non-ASCII (cyrillic, emoji, CJK) is sent via the ADBKeyBoard IME (must be installed on the device: github.com/senzhk/ADBKeyBoard) — the current keyboard is temporarily switched and restored afterwards. The response reports only the character count, never the text itself.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, serial: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'adb_key',
    description: 'Send a keyevent. Accepts names (HOME, BACK, ENTER, DPAD_UP, POWER, VOLUME_UP, MENU, TAB...) or numeric codes. verify="activity"|"ui" checks whether the key actually changed anything — see adb_tap for the same parameter.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string' }, serial: { type: 'string' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'Default "none". See adb_tap.' },
    }, required: ['key'] }
  },
  {
    name: 'adb_find_and_tap',
    description:
      'Find an on-screen element by text, resource-id or content-desc and activate it in one call — no need to read a UI dump and pick coordinates yourself.\n' +
      'How it activates the element is DERIVED from the device, not assumed: if the device reports android.hardware.touchscreen it taps the element centre; if it is a leanback (TV) device without a touchscreen, a coordinate tap would hit whatever currently HAS FOCUS instead — a silent miss — so the element is reached by walking the focus there with DPAD keys and then pressing DPAD_CENTER.\n' +
      'Every step is verified: the UI is re-dumped after each key and the focus is checked. If the focus stops moving, starts cycling between the same nodes, or the target is not reached within max_steps or the internal time budget, the tool reports exactly where it got stuck and presses NOTHING rather than guessing.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Visible label to match, checked against BOTH the text attribute and content-desc (substring by default, case-insensitive). Some TV launchers, Fire TV among them, put every label in content-desc and leave text empty.' },
      resource_id: { type: 'string', description: 'resource-id; the part after "/" is enough' },
      desc: { type: 'string', description: 'content-desc to match' },
      exact: { type: 'boolean', description: 'Require an exact match instead of substring. Default false.' },
      index: { type: 'number', description: 'Which match to use when several elements match. Without it, several matches are an error listing the candidates.' },
      max_steps: { type: 'number', description: 'Max DPAD steps on leanback devices, default 12, max 40. Each step re-dumps the UI (~1.5-2s), and the walk also stops after an internal ~25s budget so you get a report instead of a client timeout.' },
      serial: { type: 'string' }
    } }
  },
  {
    name: 'adb_install',
    description: 'Install an APK from HA filesystem (/media or /share). apk_path accepts a single .apk, an array of split-APK paths installed atomically via install-multiple, OR a single .apks/.xapk/.apkm bundle.\n' +
      'For a bundle the splits are chosen from the ACTUAL device properties (ABI list, screen density, locale) and installed with install-multiple; the bundle is unpacked add-on side, so it works on devices with no unzip (Fire OS 7). A wrong ABI leaves a non-working app, so no matching ABI split is a refusal; a density mismatch is not fatal (resources fall back to the base APK) and the nearest bucket is used with a note. Use dry_run=true to see the selection first.\n' +
      'Flags -r (reinstall), -t (allow testOnly/debug builds) and -g (grant all permissions) applied by default.',
    inputSchema: { type: 'object', properties: {
      apk_path: { type: ['string', 'array'], items: { type: 'string' }, description: 'Single APK path, array of split-APK paths, or one .apks/.xapk/.apkm bundle. Restore-after-reset: `pm path <pkg>` lists the full installed set -> adb_pull each -> pass them here as an array.' },
      abi: { type: 'string', description: 'Bundle only: force an ABI instead of the device default (e.g. armeabi-v7a)' },
      density: { type: 'number', description: 'Bundle only: force a screen density in dpi instead of the device value' },
      locales: { type: ['string', 'array'], items: { type: 'string' }, description: 'Bundle only: extra language splits to include alongside the device language (e.g. ["ru"] on an en-US device)' },
      dry_run: { type: 'boolean', description: 'Bundle only: report the chosen splits and install nothing' },
      serial: { type: 'string' }
    }, required: ['apk_path'] }
  },
  {
    name: 'adb_uninstall',
    description: 'Uninstall an app by package name. keep_data=true keeps app data (-k). For system packages, reversible bulk operations and backups, prefer adb_app.',
    inputSchema: { type: 'object', properties: { package: { type: 'string' }, keep_data: { type: 'boolean' }, serial: { type: 'string' } }, required: ['package'] }
  },
  {
    name: 'adb_push',
    description: 'Copy a file from HA filesystem (/media or /share) to the device.',
    inputSchema: { type: 'object', properties: { host_path: { type: 'string' }, device_path: { type: 'string' }, serial: { type: 'string' } }, required: ['host_path', 'device_path'] }
  },
  {
    name: 'adb_pull',
    description: 'Copy a file from the device to HA filesystem (/media or /share, e.g. into /media/VAULT/).',
    inputSchema: { type: 'object', properties: { device_path: { type: 'string' }, host_path: { type: 'string' }, serial: { type: 'string' } }, required: ['device_path', 'host_path'] }
  },
  {
    name: 'adb_logcat',
    description: 'Dump recent logcat lines (non-blocking). filter: either a logcat filterspec like "ActivityManager:I *:S" (contains ":" or "*"; *:S is auto-appended if missing so unmatched tags are silenced) or a plain substring grepped case-insensitively across the whole line. lines limits the result (default 200).',
    inputSchema: { type: 'object', properties: { filter: { type: 'string' }, lines: { type: 'number' }, serial: { type: 'string' } } }
  },
  {
    name: 'adb_app',
    description:
      'Package operations with guard rails: list/inspect apps, launch or stop them, disable (reversible) or uninstall them, back up their APKs and restore afterwards.\n' +
      'Safety model, do not work around it: every state-changing action defaults to dry_run=true; a protected set is DERIVED FROM THE DEVICE (current launcher, active IME, package installer, WebView provider, role holders where the OS has them, and account/registration packages) and any overlap aborts the whole call; work proceeds in batches with an account canary between them (a drop in the account count rolls the batch back and stops); everything applied is written to a snapshot on the HA filesystem so action=restore undoes it in one call.\n' +
      'mode=uninstall additionally requires the addon option allow_uninstall and a successful APK backup. System packages removed with --user 0 are restored via install-existing; sideloaded ones can only come back from the backup, which is why it is mandatory.\n' +
      'A second, independent guard covers disable, uninstall, stop and clear: a package that is CURRENTLY SERVING an off-device client — it holds a listening TCP socket and has an inbound ESTABLISHED connection to that same port from a non-loopback peer — is refused, naming the port and the peer. That is a live dependency the account canary cannot see, because it only looks inside the device. Only force_network=true lifts this guard — a separate flag from force, which covers a failed APK backup and nothing else — and it does not lift the protected set.\n' +
      'action=launch also accepts an intent/deep-link form: give uri and/or intent_action (with optional extras) instead of relying on the package\'s main activity. packages is then optional and, if given a single value, narrows the resolver via -p (more than one is a refusal). intent_action=android.intent.action.CALL/CALL_PRIVILEGED/CALL_EMERGENCY is refused while the addon option allow_shell is false, regardless of whether the call would actually succeed — a disabled adb_shell should not become a silent way to place a call.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'info', 'protected', 'launch', 'stop', 'clear', 'disable', 'uninstall', 'enable', 'restore', 'backup', 'state'],
          description: 'list/info/protected/state are read-only. launch/stop/clear act immediately (clear defaults to dry_run); stop and clear are also subject to the network guard. disable/uninstall/enable/restore/backup change state.'
        },
        packages: { type: ['string', 'array'], items: { type: 'string' }, description: 'Package name or array of package names. For action=launch with uri/intent_action, at most one package is accepted (used as -p to narrow the resolver); it is otherwise optional there.' },
        uri: { type: 'string', description: 'action=launch only: deep-link / intent data URI (am start -d). Its presence, together with intent_action, selects the intent-based launch instead of resolving the package\'s main activity.' },
        intent_action: { type: 'string', description: 'action=launch only: intent action, default android.intent.action.VIEW when uri is set. Must match [A-Za-z0-9_.]+. See the CALL refusal note above.' },
        extras: { type: ['object', 'string'], description: 'action=launch only: intent extras. string -> --es, boolean -> --ez, integer fitting int32 -> --ei, larger integer -> --el, anything else is a refusal naming the key. Also accepts a JSON-stringified object (same MCP-client quirk as array parameters).' },
        serial: { type: 'string' },
        filter: { type: 'string', enum: ['user', 'system', 'disabled', 'all'], description: 'action=list only, default user' },
        q: { type: 'string', description: 'action=list only: case-insensitive substring filter' },
        scope: { type: 'string', enum: ['user', 'all', 'list'], description: 'action=backup only: what to back up when packages is omitted (default user)' },
        mode: { type: 'string', enum: ['disable', 'uninstall'], description: 'How to remove. disable (default) is reversible with pm enable.' },
        dry_run: { type: 'boolean', description: 'Default true for state-changing actions. Set false to actually apply.' },
        batch_size: { type: 'number', description: 'Packages per batch between canary checks, default 5, max 25' },
        canary: { type: 'boolean', description: 'Check account count and launcher between batches, default true. Turning this off removes the only automatic protection against a latent breakage.' },
        backup: { type: 'boolean', description: 'Pull APKs before removing. Default true for uninstall, false for disable.' },
        force: { type: 'boolean', description: 'Proceed even if the APK backup failed. Off by default. This flag has nothing to do with the network guard — see force_network.' },
        force_network: { type: 'boolean', description: 'Override the network guard: act on a package even though it is currently serving an off-device client. Applies to disable, uninstall, stop and clear. It does NOT override the derived protected set, and it does not cover a failed backup. Off by default.' },
        store: { type: 'string', description: 'Where snapshots and APK backups live on the HA side, must be under /media or /share. Default /media/adb-mcp' }
      },
      required: ['action']
    }
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'adb_devices':    return session.devices();
    case 'adb_connect':    return session.connect(args);
    case 'adb_pair':       return session.pair(args);
    case 'adb_disconnect': return session.disconnect(args);
    case 'adb_shell':      return session.shell(args);
    case 'adb_logcat':     return session.logcat(args);

    case 'adb_screenshot': return ui.screenshot(args);
    case 'adb_ui_dump':    return ui.uiDump(args);
    case 'adb_tap':        return ui.tap(args);
    case 'adb_swipe':      return ui.swipe(args);
    case 'adb_text':       return ui.typeText(args);
    case 'adb_key':        return ui.key(args);
    case 'adb_find_and_tap': return ui.findAndTap(args);

    case 'adb_install':    return files.install(args);
    case 'adb_uninstall':  return files.uninstall(args);
    case 'adb_push':       return files.push(args);
    case 'adb_pull':       return files.pull(args);

    case 'adb_app':        return apps.adbApp(args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, callTool };
