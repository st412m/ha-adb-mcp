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
    description: 'Take a screenshot of the device screen. Returns a JPEG image so Claude can see the UI. Downscaled to max_px (default 1024) at JPEG quality (default 70); raise them only when fine detail matters.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' }, quality: { type: 'number', description: 'JPEG quality 30-95, default 70' }, max_px: { type: 'number', description: 'Max dimension 320-1920, default 1024' } } }
  },
  {
    name: 'adb_ui_dump',
    description: 'Dump the current UI hierarchy (uiautomator) as a compact list of interactive/labeled elements with tap coordinates @(x,y). Use together with adb_tap.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' } } }
  },
  {
    name: 'adb_tap',
    description: 'Tap at screen coordinates (x, y). Get coordinates from adb_ui_dump or adb_screenshot.',
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, serial: { type: 'string' } }, required: ['x', 'y'] }
  },
  {
    name: 'adb_swipe',
    description: 'Swipe from (x1,y1) to (x2,y2) over duration_ms (default 300).',
    inputSchema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, duration_ms: { type: 'number' }, serial: { type: 'string' } }, required: ['x1', 'y1', 'x2', 'y2'] }
  },
  {
    name: 'adb_text',
    description: 'Type text into the focused input field. ASCII goes through input text; non-ASCII (cyrillic, emoji, CJK) is sent via the ADBKeyBoard IME (must be installed on the device: github.com/senzhk/ADBKeyBoard) — the current keyboard is temporarily switched and restored afterwards.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, serial: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'adb_key',
    description: 'Send a keyevent. Accepts names (HOME, BACK, ENTER, DPAD_UP, POWER, VOLUME_UP, MENU, TAB...) or numeric codes.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, serial: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'adb_install',
    description: 'Install an APK from HA filesystem (/media or /share). apk_path accepts a single path, OR an array of split-APK paths (base.apk + config.*.apk) which are installed atomically via install-multiple. Flags -r (reinstall), -t (allow testOnly/debug builds) and -g (grant all permissions) applied by default.',
    inputSchema: { type: 'object', properties: { apk_path: { type: ['string', 'array'], items: { type: 'string' }, description: 'Single APK path, or array of split-APK paths for install-multiple (e.g. base + config.arm64_v8a + config.xxhdpi + config.<lang>). Restore-after-reset: `pm path <pkg>` lists the full installed set -> adb_pull each -> pass them here as an array.' }, serial: { type: 'string' } }, required: ['apk_path'] }
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
      'mode=uninstall additionally requires the addon option allow_uninstall and a successful APK backup. System packages removed with --user 0 are restored via install-existing; sideloaded ones can only come back from the backup, which is why it is mandatory.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'info', 'protected', 'launch', 'stop', 'clear', 'disable', 'uninstall', 'enable', 'restore', 'backup', 'state'],
          description: 'list/info/protected/state are read-only. launch/stop/clear act immediately (clear defaults to dry_run). disable/uninstall/enable/restore/backup change state.'
        },
        packages: { type: ['string', 'array'], items: { type: 'string' }, description: 'Package name or array of package names.' },
        serial: { type: 'string' },
        filter: { type: 'string', enum: ['user', 'system', 'disabled', 'all'], description: 'action=list only, default user' },
        q: { type: 'string', description: 'action=list only: case-insensitive substring filter' },
        scope: { type: 'string', enum: ['user', 'all', 'list'], description: 'action=backup only: what to back up when packages is omitted (default user)' },
        mode: { type: 'string', enum: ['disable', 'uninstall'], description: 'How to remove. disable (default) is reversible with pm enable.' },
        dry_run: { type: 'boolean', description: 'Default true for state-changing actions. Set false to actually apply.' },
        batch_size: { type: 'number', description: 'Packages per batch between canary checks, default 5, max 25' },
        canary: { type: 'boolean', description: 'Check account count and launcher between batches, default true. Turning this off removes the only automatic protection against a latent breakage.' },
        backup: { type: 'boolean', description: 'Pull APKs before removing. Default true for uninstall, false for disable.' },
        force: { type: 'boolean', description: 'Proceed even if the APK backup failed. Off by default.' },
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
