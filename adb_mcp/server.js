#!/usr/bin/env node
/**
 * ADB MCP Server — StreamableHTTP транспорт
 * Управление Android-устройствами по сетевому ADB из claude.ai.
 * Транспорт и обвязка идентичны ha-filesystem-mcp v2.3.2:
 *  - POST /mcp -> plain application/json (иммунитет к SSE-буферизации туннелей)
 *  - GET /mcp -> 405 (сервер не шлёт server-initiated notifications)
 *  - никакого structuredContent (дублирование base64-пейлоадов)
 */

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '3199');
const VERSION = '0.3.4';
const ALLOW_SHELL = process.env.ALLOW_SHELL !== 'false';
// v0.2.2: tool-call лог под тем же флагом log_requests, что и HTTP-лог proxy.js.
// HTTP-уровень показывает только "POST /mcp" — для отладки нужен уровень тулов.
const LOG_REQUESTS = process.env.LOG_REQUESTS === 'true';

// v0.3.1: типовые ошибки adb дополняются подсказкой для вызывающего
function friendlyAdbError(msg) {
  if (/device '.*' not found|no devices\/emulators found/i.test(msg))
    return `${msg}. Call adb_devices to list what is connected; network devices may need adb_connect first (wireless-debug ports change after phone reboot).`;
  if (/device offline/i.test(msg))
    return `${msg}. The TCP session died (device slept or rebooted) — run adb_disconnect for this host, then adb_connect again.`;
  if (/device unauthorized|failed to authenticate/i.test(msg))
    return `${msg}. Confirm the "Allow USB debugging?" RSA prompt on the device screen (check "Always allow").`;
  return msg;
}

function fmtArgs(a) {
  try {
    const s = JSON.stringify(a || {});
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch { return '(unserializable)'; }
}

function fmtOutcome(content) {
  if (!Array.isArray(content) || !content.length) return 'ok';
  const c = content[0];
  if (c.type === 'image') return `image ${Math.round((c.data || '').length * 3 / 4 / 1024)}KB`;
  const len = (c.text || '').length;
  return `ok ${len}B`;
}

function logTool(name, args, t0, outcome) {
  if (!LOG_REQUESTS) return;
  console.log(`[tool] ${new Date().toISOString()} ${name} ${fmtArgs(args)} -> ${outcome} ${Date.now() - t0}ms`);
}

// push/pull ограничены этими корнями на стороне HA
const FILE_ROOTS = ['/media', '/share'];

const ADB_TIMEOUT_MS = 30000;
const ADB_MAX_BUFFER = 16 * 1024 * 1024;

function resolveSafeHostPath(p) {
  const resolved = path.resolve(p);
  if (!FILE_ROOTS.some(root => resolved === root || resolved.startsWith(root + '/')))
    throw new Error(`Access denied (host path outside ${FILE_ROOTS.join(', ')}): ${p}`);
  return resolved;
}

function adb(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, {
      timeout: opts.timeout || ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
      encoding: opts.binary ? 'buffer' : 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        // v0.3.2: не терять stdout при exit!=0 — при отладке shell-пайплайнов
        // сообщение "Command failed: adb ..." без вывода команды бесполезно.
        let msg = (stderr || '').toString().trim() || err.message;
        const out = opts.binary ? '' : (stdout || '').toString().trim();
        if (out) msg = `${msg}\nstdout (tail): ${out.slice(-2000)}`;
        return reject(new Error(friendlyAdbError(msg)));
      }
      resolve(opts.withStderr ? { stdout, stderr } : stdout);
    });
  });
}

function withSerial(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

function text(t) { return [{ type: 'text', text: t }]; }

// input text: adb требует экранирования пробелов и спецсимволов
function escapeInputText(s) {
  return s
    .replace(/[\\%&()<>|;$*'"`#!~\[\]{}^]/g, m => '\\' + m)
    .replace(/ /g, '%s');
}

// Компактный парсер uiautomator dump: node-строки -> список интерактивных элементов
function parseUiDump(xml) {
  const nodes = [];
  const re = /<node[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const attr = name => {
      const a = tag.match(new RegExp(`${name}="([^"]*)"`));
      return a ? a[1] : '';
    };
    const bounds = attr('bounds');
    const b = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const clickable = attr('clickable') === 'true';
    const txt = attr('text');
    const desc = attr('content-desc');
    const rid = attr('resource-id');
    const focused = attr('focused') === 'true';
    // Показываем узлы, с которыми есть смысл взаимодействовать или которые несут текст
    if (!clickable && !txt && !desc && !focused) continue;
    if (!b) continue;
    const cx = Math.round((+b[1] + +b[3]) / 2);
    const cy = Math.round((+b[2] + +b[4]) / 2);
    nodes.push(
      `${clickable ? '[BTN]' : '[TXT]'}${focused ? '[FOCUSED]' : ''} ` +
      `${txt || desc || '(no text)'}` +
      `${rid ? ` id=${rid.split('/').pop()}` : ''}` +
      ` @(${cx},${cy}) bounds=${bounds}`
    );
  }
  return nodes.length ? nodes.join('\n') : '(no interactive/labeled nodes found)';
}

// v0.2.1: uiautomator может отдать устаревший дамп (кэш) сразу после смены экрана.
// Храним хэш последнего дампа per-serial: если новый дамп побайтово совпал с
// предыдущим — ждём 600мс и дампим повторно (наблюдалось на S20 FE, смоук 18.07).
const lastUiDumpHash = new Map();


// v0.3.4: скриншот через shell-пайплайн `adb exec-out screencap | convert`.
// Полнокадровый PNG (~3 MB) идёт по kernel pipe между adb и convert и НЕ
// заходит в Node вообще — в JS попадает только сжатый JPEG со stdout convert.
// Причина: soak 20-21.07 показал храповик ~3 MB RSS на вызов (полнокадровый
// буфер `raw` + временные файлы в v<=0.3.2 удерживали память процесса).
// Вариант v0.3.3 с fd-passing (stdio: [a.stdout, ...]) отброшен: известная
// гонка nodejs/node#9413 — на Alpine convert стабильно не получал данные
// (exit 0, пустой stdout). Shell-пайплайн переносим и детерминирован;
// pipefail не нужен: при падении adb convert получает EOF/мусор и выходит
// с ошибкой, причина видна в общем stderr.
function screenshotPipeline(serial, px, q) {
  return new Promise((resolve, reject) => {
    const sq = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const cmd = `adb ${serial ? `-s ${sq(serial)} ` : ''}exec-out screencap -p | ` +
      `convert png:- -resize ${sq(px + 'x' + px + '>')} -quality ${q} jpg:-`;
    execFile('sh', ['-c', cmd], {
      timeout: ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
      encoding: 'buffer',
    }, (err, stdout, stderr) => {
      // stderr общий у adb и convert — friendlyAdbError матчит adb-паттерны
      const errTxt = (stderr || '').toString().trim();
      if (err) return reject(new Error(friendlyAdbError(errTxt || err.message)));
      if (!stdout || !stdout.length)
        return reject(new Error(friendlyAdbError(errTxt ||
          'empty screenshot (screencap produced no data — device asleep or protected content?)')));
      resolve(stdout.toString('base64'));
    });
  });
}

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
    description: 'Install an APK from HA filesystem (/media or /share, e.g. /media/VAULT/apk/app.apk). Flags -r (reinstall), -t (allow testOnly/debug builds) and -g (grant all permissions) applied by default.',
    inputSchema: { type: 'object', properties: { apk_path: { type: 'string' }, serial: { type: 'string' } }, required: ['apk_path'] }
  },
  {
    name: 'adb_uninstall',
    description: 'Uninstall an app by package name. keep_data=true keeps app data (-k).',
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
];

async function callTool(name, args) {
  const serial = args.serial;

  switch (name) {
    case 'adb_devices': {
      const out = await adb(['devices', '-l']);
      return text(out.trim() || 'No devices');
    }

    case 'adb_connect': {
      const host = args.host.includes(':') ? args.host : `${args.host}:5555`;
      const out = (await adb(['connect', host], { timeout: 10000 })).toString().trim();
      // adb пишет неуспех коннекта в stdout с exit 0 — превращаем в ошибку
      if (/failed to connect|unable to connect|cannot connect/i.test(out))
        throw new Error(`${out}. Check the device is awake and the port is current (wireless-debug ports change after device reboot).`);
      return text(out);
    }

    case 'adb_pair': {
      // Wireless Debugging (Android 11+): порт pairing-диалога рандомный,
      // дефолта нет — требуем ip:port явно. Код может прийти числом от
      // MCP-клиента — приводим к строке.
      if (!String(args.host).includes(':'))
        throw new Error('Pairing requires ip:port — the random port from the "Pair device with pairing code" dialog (not 5555)');
      const out = await adb(['pair', String(args.host), String(args.code)], { timeout: 20000 });
      return text(out.trim());
    }

    case 'adb_disconnect': {
      const out = await adb(args.host ? ['disconnect', args.host] : ['disconnect'], { timeout: 10000 });
      return text(out.trim() || 'Disconnected');
    }

    case 'adb_shell': {
      if (!ALLOW_SHELL) throw new Error('adb_shell is disabled in addon config (allow_shell: false)');
      const timeout = args.timeout_sec ? Math.min(args.timeout_sec * 1000, 120000) : ADB_TIMEOUT_MS;
      const out = await adb(withSerial(serial, ['shell', args.command]), { timeout });
      return text(out.toString().trim() || '(empty output)');
    }

    case 'adb_screenshot': {
      const q = Math.min(Math.max(Math.round(args.quality || 70), 30), 95);
      const px = Math.min(Math.max(Math.round(args.max_px || 1024), 320), 1920);
      const data = await screenshotPipeline(serial, px, q);
      return [{ type: 'image', data, mimeType: 'image/jpeg' }];
    }

    case 'adb_ui_dump': {
      const dumpOnce = async () => {
        const st = (await adb(withSerial(serial, ['shell', 'uiautomator dump /sdcard/adbmcp_ui.xml 2>&1']))).toString();
        if (!/dumped to/i.test(st) && /error/i.test(st)) throw new Error(`uiautomator: ${st.trim()}`);
        const xml = (await adb(withSerial(serial, ['shell', 'cat /sdcard/adbmcp_ui.xml']))).toString();
        await adb(withSerial(serial, ['shell', 'rm -f /sdcard/adbmcp_ui.xml'])).catch(() => {});
        return xml;
      };
      const key = serial || '_default';
      let xml = await dumpOnce();
      if (lastUiDumpHash.get(key) === crypto.createHash('md5').update(xml).digest('hex')) {
        // Идентичен предыдущему дампу — вероятен stale-кэш uiautomator после
        // смены экрана. Даём UI устояться и дампим ещё раз.
        await new Promise(r => setTimeout(r, 600));
        xml = await dumpOnce();
      }
      lastUiDumpHash.set(key, crypto.createHash('md5').update(xml).digest('hex'));
      return text(parseUiDump(xml));
    }

    case 'adb_tap': {
      await adb(withSerial(serial, ['shell', `input tap ${Math.round(args.x)} ${Math.round(args.y)}`]));
      return text(`Tapped (${Math.round(args.x)}, ${Math.round(args.y)})`);
    }

    case 'adb_swipe': {
      const d = args.duration_ms || 300;
      await adb(withSerial(serial, ['shell',
        `input swipe ${Math.round(args.x1)} ${Math.round(args.y1)} ${Math.round(args.x2)} ${Math.round(args.y2)} ${Math.round(d)}`]));
      return text(`Swiped (${args.x1},${args.y1}) -> (${args.x2},${args.y2}) in ${d}ms`);
    }

    case 'adb_text': {
      const t = String(args.text);
      if (/^[\x20-\x7E]*$/.test(t)) {
        await adb(withSerial(serial, ['shell', `input text "${escapeInputText(t)}"`]));
        return text(`Typed: ${t}`);
      }
      // v0.3.0: не-ASCII через ADBKeyBoard (input text не умеет unicode).
      // Порядок: проверить установку -> запомнить текущий IME -> переключить
      // на AdbIME -> broadcast ADB_INPUT_B64 (base64 = shell-safe) -> вернуть IME.
      const pkgs = (await adb(withSerial(serial, ['shell', 'pm list packages com.android.adbkeyboard']))).toString();
      if (!pkgs.includes('com.android.adbkeyboard'))
        throw new Error('Non-ASCII text requires ADBKeyBoard on the device. Install it (github.com/senzhk/ADBKeyBoard, pm install -r -t -g ADBKeyboard.apk from /data/local/tmp), then retry.');
      const prevIme = (await adb(withSerial(serial, ['shell', 'settings get secure default_input_method']))).toString().trim();
      const b64 = Buffer.from(t, 'utf8').toString('base64');
      try {
        await adb(withSerial(serial, ['shell', 'ime enable com.android.adbkeyboard/.AdbIME >/dev/null 2>&1; ime set com.android.adbkeyboard/.AdbIME']));
        await new Promise(r => setTimeout(r, 700)); // IME-переключение асинхронное
        await adb(withSerial(serial, ['shell', `am broadcast -a ADB_INPUT_B64 --es msg ${b64}`]));
      } finally {
        if (prevIme && prevIme !== 'null' && !prevIme.includes('adbkeyboard'))
          await adb(withSerial(serial, ['shell', `ime set ${prevIme}`])).catch(() => {});
      }
      return text(`Typed (unicode via ADBKeyBoard): ${t}`);
    }

    case 'adb_key': {
      const key = /^\d+$/.test(args.key) ? args.key : `KEYCODE_${args.key.toUpperCase().replace(/^KEYCODE_/, '')}`;
      await adb(withSerial(serial, ['shell', `input keyevent ${key}`]));
      return text(`Sent keyevent ${key}`);
    }

    case 'adb_install': {
      const apk = resolveSafeHostPath(args.apk_path);
      if (!fs.existsSync(apk)) throw new Error(`APK not found: ${apk}`);
      const out = await adb(withSerial(serial, ['install', '-r', '-t', '-g', apk]), { timeout: 120000 });
      return text(out.trim());
    }

    case 'adb_uninstall': {
      const a = ['uninstall'];
      if (args.keep_data === true || args.keep_data === 'true') a.push('-k');
      a.push(args.package);
      const out = await adb(withSerial(serial, a), { timeout: 60000 });
      return text(out.trim());
    }

    case 'adb_push': {
      const src = resolveSafeHostPath(args.host_path);
      if (!fs.existsSync(src)) throw new Error(`File not found: ${src}`);
      const size = fs.statSync(src).size;
      // adb push пишет статистику в stderr, когда stdout не TTY — забираем оба
      const r = await adb(withSerial(serial, ['push', src, args.device_path]), { timeout: 120000, withStderr: true });
      const out = `${r.stdout}\n${r.stderr}`.trim();
      return text(out || `Pushed ${src} -> ${args.device_path} (${size} bytes)`);
    }

    case 'adb_pull': {
      const dst = resolveSafeHostPath(args.host_path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const r = await adb(withSerial(serial, ['pull', args.device_path, dst]), { timeout: 120000, withStderr: true });
      const out = `${r.stdout}\n${r.stderr}`.trim();
      let size = 0;
      try { const st = fs.statSync(dst); size = st.isFile() ? st.size : 0; } catch {}
      return text(out || `Pulled ${args.device_path} -> ${dst}${size ? ` (${size} bytes)` : ''}`);
    }

    case 'adb_logcat': {
      const lines = Math.min(args.lines || 200, 2000);
      const raw = (args.filter || '').trim();
      // Экранирование для одинарных кавычек device-shell
      const sq = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
      let out;
      if (!raw) {
        out = (await adb(withSerial(serial, ['logcat', '-d', '-t', String(lines)]), { timeout: 20000 })).toString();
      } else if (/[:*]/.test(raw)) {
        // filterspec: фильтр по ВСЕМУ буферу, tail НА УСТРОЙСТВЕ. С -t N logcat
        // сначала режет буфер до N сырых строк и лишь потом фильтрует (баг
        // v0.2.0 — пустой вывод). Без *:S несматченные теги не глушатся —
        // добавляем. Tail device-side: болтливый тег на весь буфер не влезает
        // в maxBuffer при переносе на хост (баг v0.2.1).
        const spec = raw.split(/\s+/);
        if (!spec.some(x => x.startsWith('*'))) spec.push('*:S');
        const cmd = `logcat -d ${spec.map(sq).join(' ')} 2>/dev/null | tail -n ${lines}`;
        out = (await adb(withSerial(serial, ['shell', cmd]), { timeout: 20000 })).toString();
      } else {
        // substring: регистронезависимый grep НА УСТРОЙСТВЕ (в v0.2.0 уходил
        // как filterspec = no-op; в v0.2.1 полный дамп рвал maxBuffer).
        // v0.3.2: Fire OS подменяет /system/bin/grep на BSD grep 2.5.1-FreeBSD,
        // который после бинарных байтов в crash-буфере logcat матчит ВСЁ
        // (passthrough; -a и LC_ALL=C не лечат — смоук Fire TV 19.07). toybox
        // grep исправен — используем его, когда доступен; иначе прежний grep
        // (стоковый Android: /system/bin/grep И ЕСТЬ toybox — поведение не
        // меняется). Финальный `:` — 0 совпадений это пустой результат
        // "(empty)", а не ошибка exit 1.
        const cmd = `G="grep"; command -v toybox >/dev/null 2>&1 && toybox grep --help >/dev/null 2>&1 && G="toybox grep"; ` +
          `logcat -d 2>/dev/null | $G -iF -- ${sq(raw)} | tail -n ${lines}; :`;
        out = (await adb(withSerial(serial, ['shell', cmd]), { timeout: 20000 })).toString();
      }
      return text(out.trim().slice(-64000) || '(empty)');
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcpRequest(body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'adb-mcp-server', version: VERSION }
    }};
  }

  if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'roots/list') return { jsonrpc: '2.0', id, result: { roots: [] } };

  if (method === 'tools/call') {
    const t0 = Date.now();
    try {
      const content = await callTool(params.name, params.arguments || {});
      logTool(params.name, params.arguments, t0, fmtOutcome(content));
      return { jsonrpc: '2.0', id, result: { content } };
    } catch (e) {
      logTool(params.name, params.arguments, t0, `ERROR: ${e.message}`);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }

  // Сервер не шлёт server-initiated notifications — GET SSE-канал не нужен,
  // отвечаем 405 вместо мёртвого стрима (см. ha-filesystem-mcp issue #4).
  if (req.method !== 'POST') { res.writeHead(405, { 'Allow': 'POST, OPTIONS' }); res.end(); return; }

  const accept = req.headers['accept'] || '';
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    res.writeHead(406);
    res.end(JSON.stringify({ error: 'Not Acceptable: Client must accept both application/json and text/event-stream' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const r of requests) {
      const resp = await handleMcpRequest(r);
      if (resp !== null) responses.push(resp);
    }

    const result = Array.isArray(body) ? responses : (responses[0] || null);
    if (result === null) { res.writeHead(202); res.end(); return; }

    // Plain JSON вместо одноэвентного SSE — иммунитет к буферизации туннелей.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
});

server.listen(PORT, () => {
  process.stderr.write(`ADB MCP Server v${VERSION} on port ${PORT} (shell ${ALLOW_SHELL ? 'enabled' : 'DISABLED'}, tool log ${LOG_REQUESTS ? 'ON' : 'off'})\n`);
});
