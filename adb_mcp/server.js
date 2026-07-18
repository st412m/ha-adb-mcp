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
const os = require('os');

const PORT = parseInt(process.argv[2] || '3199');
const VERSION = '0.2.0';
const ALLOW_SHELL = process.env.ALLOW_SHELL !== 'false';

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
        const msg = (stderr || '').toString().trim() || err.message;
        return reject(new Error(msg));
      }
      resolve(stdout);
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
    description: 'Take a screenshot of the device screen. Returns a JPEG image (downscaled to max 1280px wide) so Claude can see the UI.',
    inputSchema: { type: 'object', properties: { serial: { type: 'string' } } }
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
    description: 'Type text into the focused input field.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, serial: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'adb_key',
    description: 'Send a keyevent. Accepts names (HOME, BACK, ENTER, DPAD_UP, POWER, VOLUME_UP, MENU, TAB...) or numeric codes.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, serial: { type: 'string' } }, required: ['key'] }
  },
  {
    name: 'adb_install',
    description: 'Install an APK from HA filesystem (/media or /share, e.g. /media/VAULT/apk/app.apk). Flags -r (reinstall) and -g (grant all permissions) applied by default.',
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
    description: 'Dump recent logcat lines (non-blocking, -d). Optional filter spec like "ActivityManager:I *:S" or tag substring, and lines limit (default 200).',
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
      const out = await adb(['connect', host], { timeout: 10000 });
      return text(out.trim());
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
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adbmcp-'));
      try {
        const png = path.join(tmp, 'screen.png');
        const jpg = path.join(tmp, 'screen.jpg');
        const raw = await adb(withSerial(serial, ['exec-out', 'screencap', '-p']), { binary: true });
        fs.writeFileSync(png, raw);
        await new Promise((res, rej) => execFile('convert', [
          png, '-resize', '1280x1280>', '-quality', '80', jpg
        ], e => e ? rej(e) : res()));
        return [{ type: 'image', data: fs.readFileSync(jpg).toString('base64'), mimeType: 'image/jpeg' }];
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      }
    }

    case 'adb_ui_dump': {
      await adb(withSerial(serial, ['shell', 'uiautomator dump /sdcard/adbmcp_ui.xml']));
      const xml = await adb(withSerial(serial, ['shell', 'cat /sdcard/adbmcp_ui.xml']));
      await adb(withSerial(serial, ['shell', 'rm -f /sdcard/adbmcp_ui.xml'])).catch(() => {});
      return text(parseUiDump(xml.toString()));
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
      await adb(withSerial(serial, ['shell', `input text "${escapeInputText(args.text)}"`]));
      return text(`Typed: ${args.text}`);
    }

    case 'adb_key': {
      const key = /^\d+$/.test(args.key) ? args.key : `KEYCODE_${args.key.toUpperCase().replace(/^KEYCODE_/, '')}`;
      await adb(withSerial(serial, ['shell', `input keyevent ${key}`]));
      return text(`Sent keyevent ${key}`);
    }

    case 'adb_install': {
      const apk = resolveSafeHostPath(args.apk_path);
      if (!fs.existsSync(apk)) throw new Error(`APK not found: ${apk}`);
      const out = await adb(withSerial(serial, ['install', '-r', '-g', apk]), { timeout: 120000 });
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
      const out = await adb(withSerial(serial, ['push', src, args.device_path]), { timeout: 120000 });
      return text(out.trim());
    }

    case 'adb_pull': {
      const dst = resolveSafeHostPath(args.host_path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const out = await adb(withSerial(serial, ['pull', args.device_path, dst]), { timeout: 120000 });
      return text(out.trim());
    }

    case 'adb_logcat': {
      const lines = Math.min(args.lines || 200, 2000);
      const a = ['logcat', '-d', '-t', String(lines)];
      if (args.filter) a.push(...args.filter.split(/\s+/));
      const out = await adb(withSerial(serial, a), { timeout: 20000 });
      return text(out.toString().trim().slice(-64000) || '(empty)');
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
    try {
      const content = await callTool(params.name, params.arguments || {});
      return { jsonrpc: '2.0', id, result: { content } };
    } catch (e) {
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
  process.stderr.write(`ADB MCP Server v${VERSION} on port ${PORT} (shell ${ALLOW_SHELL ? 'enabled' : 'DISABLED'})\n`);
});
