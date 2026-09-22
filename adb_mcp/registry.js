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
    description: 'Take a screenshot of the device screen. Returns a JPEG image, then a text line with the logical screen size, the image size and the scale between them, e.g. "screen 1080x2340 -> image 473x1024 · scale 2.283/2.285". Pass coords="screenshot" to adb_tap/adb_swipe to tap coordinates read off that image. A near-uniformly dark frame is a warning after the image, not a refusal.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' }, quality: { type: 'number', description: 'JPEG quality 30-95, default 70' }, max_px: { type: 'number', description: 'Max dimension 320-1920, default 1024' } } }
  },
  {
    name: 'adb_ui_dump',
    description: 'Dump the current UI hierarchy (uiautomator) as a compact list of interactive/labeled elements with tap coordinates @(x,y). Password fields are marked [PASSWORD] and listed even with no visible text. Use together with adb_tap.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' } } }
  },
  {
    name: 'adb_tap',
    description: 'Tap at (x, y). coords="screen" (default): coordinates from adb_ui_dump, the logical space input tap uses. coords="screenshot": coordinates off the last adb_screenshot for the SAME serial, rescaled; missing or older than 120s is refused. Rotation between screenshot and tap is not checked. verify="activity"|"ui" reports whether the tap changed anything; a failed verify never turns a performed tap into an error.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number' }, y: { type: 'number' }, serial: { type: 'string' },
      coords: { type: 'string', enum: ['screen', 'screenshot'], description: 'Coordinate space, default "screen". "screenshot" = pixels read off the last adb_screenshot image for this serial, rescaled automatically; refused if that screenshot is missing or older than 120s.' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'Default "none". "activity" compares the resumed activity before/after. "ui" also hashes the UI dump (~2-4s); a clock or timer ticking on its own can make it report "changed". "unchanged" is reliable.' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'adb_swipe',
    description: 'Swipe from (x1,y1) to (x2,y2) over duration_ms (default 300). The same point at both ends with duration_ms >= 800 is a long-press. coords and verify work as in adb_tap and both endpoints share one coordinate space; with verify="ui", an "unchanged" result on a swipe usually means the end of a scrollable list.',
    inputSchema: { type: 'object', properties: {
      x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'number' }, serial: { type: 'string' },
      coords: { type: 'string', enum: ['screen', 'screenshot'], description: 'Coordinate space for BOTH endpoints, default "screen". See adb_tap for the "screenshot" semantics and its 120s TTL.' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'See adb_tap. For a swipe, "ui" reporting "unchanged" usually means you hit the end of a scrollable list rather than that nothing happened.' },
    }, required: ['x1', 'y1', 'x2', 'y2'] }
  },
  {
    name: 'adb_text',
    description: 'Type text into the focused input field. ASCII goes through input text; non-ASCII (Cyrillic, emoji, CJK) is sent via the ADBKeyBoard IME, which must be installed on the device (github.com/senzhk/ADBKeyBoard): the current keyboard is switched to it and restored afterwards. The response reports only the character count, never the text itself.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, serial: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'adb_key',
    description: 'Send a keyevent. Accepts names (HOME, BACK, ENTER, DPAD_UP, POWER, VOLUME_UP, MENU, TAB...) or numeric codes. verify="activity"|"ui" reports whether the key changed anything; see adb_tap for the same parameter.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string' }, serial: { type: 'string' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'Default "none". See adb_tap.' },
    }, required: ['key'] }
  },
  {
    name: 'adb_find_and_tap',
    description:
      'Find an on-screen element by text, resource-id or content-desc and activate it.\n' +
      'The method is derived from the device: with a touchscreen the element centre is tapped; on leanback without one the focus is walked there with DPAD keys, since a coordinate tap activates whatever has focus.\n' +
      'If the focus stalls, cycles, or the target is not reached in max_steps or the time budget, nothing is pressed and the tool reports where it stopped.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Visible label to match, checked against both the text attribute and content-desc (substring by default, case-insensitive). Some TV launchers put every label in content-desc and leave text empty.' },
      resource_id: { type: 'string', description: 'resource-id; the part after "/" is enough' },
      desc: { type: 'string', description: 'content-desc to match' },
      exact: { type: 'boolean', description: 'Require an exact match instead of substring. Default false.' },
      index: { type: 'number', description: 'Which match to use when several elements match. Without it, several matches are an error listing the candidates.' },
      max_steps: { type: 'number', description: 'Max DPAD steps on leanback devices, default 12, max 40. Each step re-dumps the UI (~1.5-2s) and the walk also stops after an internal ~25s budget, returning a report instead of timing out.' },
      serial: { type: 'string' }
    } }
  },
  {
    name: 'adb_install',
    description: 'Install an APK from the HA filesystem (/media or /share). apk_path takes a single .apk, an array of split-APK paths, or one .apks/.xapk/.apkm bundle.\n' +
      'Bundle splits are chosen from the device ABI list, density and locale. No matching ABI split is a refusal; a density mismatch is not. dry_run=true reports the selection and installs nothing.\n' +
      'Flags -r, -t and -g are applied by default.',
    inputSchema: { type: 'object', properties: {
      apk_path: { type: ['string', 'array'], items: { type: 'string' }, description: 'Single APK path, array of split-APK paths, or one .apks/.xapk/.apkm bundle. To restore an app, `pm path <pkg>` lists its full split set: adb_pull each and pass them here as an array.' },
      abi: { type: 'string', description: 'Bundle only: force an ABI instead of the device default (e.g. armeabi-v7a)' },
      density: { type: 'number', description: 'Bundle only: force a screen density in dpi instead of the device value' },
      locales: { type: ['string', 'array'], items: { type: 'string' }, description: 'Bundle only: extra language splits to include alongside the device language (e.g. ["ru"] on an en-US device)' },
      dry_run: { type: 'boolean', description: 'Bundle only: report the chosen splits and install nothing' },
      serial: { type: 'string' }
    }, required: ['apk_path'] }
  },
  {
    name: 'adb_uninstall',
    description: 'Uninstall an app by package name. keep_data=true keeps app data (-k). For system packages, reversible bulk operations and backups, use adb_app.',
    inputSchema: { type: 'object', properties: { package: { type: 'string' }, keep_data: { type: 'boolean' }, serial: { type: 'string' } }, required: ['package'] }
  },
  {
    name: 'adb_push',
    description: 'Copy a file from HA filesystem (/media or /share) to the device.',
    inputSchema: { type: 'object', properties: { host_path: { type: 'string' }, device_path: { type: 'string' }, serial: { type: 'string' } }, required: ['host_path', 'device_path'] }
  },
  {
    name: 'adb_pull',
    description: 'Copy a file from the device to HA filesystem (/media or /share, e.g. into /media/).',
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
      'Package operations with guard rails: inspect, launch, stop, clear, disable, uninstall, back up and restore packages.\n' +
      'Every state-changing action defaults to dry_run=true. A protected set derived from the device (launcher, active IME, installer, WebView provider, role holders, account packages) aborts the whole call on any overlap, and has no override.\n' +
      'A network guard refuses disable, uninstall, stop and clear while the package is serving an off-device client, naming the port and the peer. Only force_network=true lifts it; force covers a failed APK backup and nothing else.\n' +
      'An account canary between batches rolls a batch back and stops on a drop. Everything applied goes into a snapshot, so action=restore undoes it. mode=uninstall also needs the add-on option allow_uninstall and a successful APK backup.\n' +
      'action=launch also accepts uri and/or intent_action for an intent or deep link; CALL, CALL_PRIVILEGED and CALL_EMERGENCY are refused while allow_shell is false.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'info', 'protected', 'launch', 'stop', 'clear', 'disable', 'uninstall', 'enable', 'restore', 'backup', 'state'],
          description: 'list/info/protected/state are read-only. launch/stop/clear act immediately (clear defaults to dry_run) and stop/clear are under the network guard. disable/uninstall/enable/restore/backup change state.'
        },
        packages: { type: ['string', 'array'], items: { type: 'string' }, description: 'Package name or array of package names. For action=launch with uri/intent_action, at most one package is accepted (used as -p to narrow the resolver); it is otherwise optional there.' },
        uri: { type: 'string', description: 'action=launch only: deep-link / intent data URI (am start -d). Its presence, together with intent_action, selects the intent-based launch instead of resolving the package\'s main activity.' },
        intent_action: { type: 'string', description: 'action=launch only: intent action, default android.intent.action.VIEW when uri is set. Must match [A-Za-z0-9_.]+. See the CALL refusal note above.' },
        extras: { type: ['object', 'string'], description: 'action=launch only: intent extras. string -> --es, boolean -> --ez, int32 integer -> --ei, larger integer -> --el; anything else is refused by key name. A JSON-stringified object is accepted too.' },
        serial: { type: 'string' },
        filter: { type: 'string', enum: ['user', 'system', 'disabled', 'all'], description: 'action=list only, default user' },
        q: { type: 'string', description: 'action=list only: case-insensitive substring filter' },
        scope: { type: 'string', enum: ['user', 'all', 'list'], description: 'action=backup only: what to back up when packages is omitted (default user)' },
        mode: { type: 'string', enum: ['disable', 'uninstall'], description: 'How to remove. disable (default) is reversible with pm enable.' },
        dry_run: { type: 'boolean', description: 'Default true for state-changing actions. Set false to actually apply.' },
        batch_size: { type: 'number', description: 'Packages per batch between canary checks, default 5, max 25' },
        canary: { type: 'boolean', description: 'Check the account count and the launcher between batches, default true. Turning it off removes the only automatic check for a latent breakage.' },
        backup: { type: 'boolean', description: 'Pull APKs before removing. Default true for uninstall, false for disable.' },
        force: { type: 'boolean', description: 'Proceed even if the APK backup failed. Off by default. It does not affect the network guard; see force_network.' },
        force_network: { type: 'boolean', description: 'Override the network guard for disable, uninstall, stop and clear: act on a package that is currently serving an off-device client. It does NOT override the protected set. Off by default.' },
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
