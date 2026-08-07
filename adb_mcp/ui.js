'use strict';
/**
 * ui.js — экран и ввод.
 *
 * ⚠ Скриншот: ТОЛЬКО файловый конвейер (adb exec-out > tmp -> magick
 * file->file -> cat). К форме `adb exec-out | magick png:- ... jpg:-` НЕ
 * возвращаться — именно она сломала 0.3.3-0.3.5, а буферизация PNG в Node
 * давала утечку ~3 МБ на кадр (соак 19-21.07, фикс 0.3.6).
 *
 * parseUiNodes отдаёт СТРУКТУРУ, а форматирование — отдельно: это заготовка
 * под adb_find_and_tap, чтобы поиск элемента не разбирал собственный текст.
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const { adb, withSerial, text, escapeInputText, ADB_TIMEOUT_MS, ADB_MAX_BUFFER } = require('./adb.js');

function screenshotPipeline(serial, px, q) {
  return new Promise((resolve, reject) => {
    const sqq = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const cmd =
      `IM=convert; command -v magick >/dev/null 2>&1 && IM=magick; ` +
      `T=$(mktemp -d) || exit 96; trap 'rm -rf "$T"' EXIT; ` +
      `adb ${serial ? `-s ${sqq(serial)} ` : ''}exec-out screencap -p > "$T/s.png" || exit 97; ` +
      `[ -s "$T/s.png" ] || exit 98; ` +
      `"$IM" "$T/s.png" -resize ${sqq(px + 'x' + px + '>')} -quality ${q} "$T/s.jpg" || exit 99; ` +
      `cat "$T/s.jpg"`;
    execFile('sh', ['-c', cmd], {
      timeout: ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
      encoding: 'buffer',
    }, (err, stdout, stderr) => {
      const errTxt = (stderr || '').toString().split('\n')
        .filter(l => l.trim() && !/deprecated in IMv7/i.test(l))
        .join('\n').trim();
      if (err) {
        const stage = { 96: 'mktemp failed', 97: 'adb exec-out screencap failed',
          98: 'screencap produced no data (device asleep or protected content?)',
          99: 'image conversion failed' }[err.code];
        const why = err.killed ? `killed${err.signal ? ' by ' + err.signal : ''} (timeout?)`
          : (stage || `pipeline exit ${err.code}`);
        return reject(new Error(errTxt ? `${why}: ${errTxt}` : `${why}${stage ? '' : ': ' + err.message}`));
      }
      if (!stdout || !stdout.length) return reject(new Error(errTxt || 'empty screenshot'));
      resolve(stdout.toString('base64'));
    });
  });
}

async function screenshot(args) {
  const q = Math.min(Math.max(Math.round(args.quality || 70), 30), 95);
  const px = Math.min(Math.max(Math.round(args.max_px || 1024), 320), 1920);
  const data = await screenshotPipeline(args.serial, px, q);
  return [{ type: 'image', data, mimeType: 'image/jpeg' }];
}

/** Разбор дампа uiautomator в структуру. */
function parseUiNodes(xml) {
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
    if (!clickable && !txt && !desc && !focused) continue;
    if (!b) continue;
    nodes.push({
      text: txt, desc, resourceId: rid, clickable, focused, bounds,
      x: Math.round((+b[1] + +b[3]) / 2),
      y: Math.round((+b[2] + +b[4]) / 2),
    });
  }
  return nodes;
}

function formatUiNodes(nodes) {
  if (!nodes.length) return '(no interactive/labeled nodes found)';
  return nodes.map(n =>
    `${n.clickable ? '[BTN]' : '[TXT]'}${n.focused ? '[FOCUSED]' : ''} ` +
    `${n.text || n.desc || '(no text)'}` +
    `${n.resourceId ? ` id=${n.resourceId.split('/').pop()}` : ''}` +
    ` @(${n.x},${n.y}) bounds=${n.bounds}`
  ).join('\n');
}

// v0.2.1: uiautomator может отдать устаревший дамп сразу после смены экрана
const lastUiDumpHash = new Map();

async function dumpXml(serial) {
  const st = (await adb(withSerial(serial, ['shell', 'uiautomator dump /sdcard/adbmcp_ui.xml 2>&1']))).toString();
  if (!/dumped to/i.test(st) && /error/i.test(st)) throw new Error(`uiautomator: ${st.trim()}`);
  const xml = (await adb(withSerial(serial, ['shell', 'cat /sdcard/adbmcp_ui.xml']))).toString();
  await adb(withSerial(serial, ['shell', 'rm -f /sdcard/adbmcp_ui.xml'])).catch(() => {});
  return xml;
}

async function uiXmlFresh(serial) {
  const key = serial || '_default';
  let xml = await dumpXml(serial);
  const h = x => crypto.createHash('md5').update(x).digest('hex');
  if (lastUiDumpHash.get(key) === h(xml)) {
    await new Promise(r => setTimeout(r, 600));
    xml = await dumpXml(serial);
  }
  lastUiDumpHash.set(key, h(xml));
  return xml;
}

async function uiDump(args) {
  const xml = await uiXmlFresh(args.serial);
  return text(formatUiNodes(parseUiNodes(xml)));
}

async function tap(args) {
  await adb(withSerial(args.serial, ['shell', `input tap ${Math.round(args.x)} ${Math.round(args.y)}`]));
  return text(`Tapped (${Math.round(args.x)}, ${Math.round(args.y)})`);
}

async function swipe(args) {
  const d = args.duration_ms || 300;
  await adb(withSerial(args.serial, ['shell',
    `input swipe ${Math.round(args.x1)} ${Math.round(args.y1)} ${Math.round(args.x2)} ${Math.round(args.y2)} ${Math.round(d)}`]));
  return text(`Swiped (${args.x1},${args.y1}) -> (${args.x2},${args.y2}) in ${d}ms`);
}

async function typeText(args) {
  const serial = args.serial;
  const t = String(args.text);
  if (/^[\x20-\x7E]*$/.test(t)) {
    await adb(withSerial(serial, ['shell', `input text "${escapeInputText(t)}"`]));
    return text(`Typed: ${t}`);
  }
  // v0.3.0: не-ASCII через ADBKeyBoard (input text не умеет unicode)
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

async function key(args) {
  const k = /^\d+$/.test(args.key) ? args.key : `KEYCODE_${args.key.toUpperCase().replace(/^KEYCODE_/, '')}`;
  await adb(withSerial(args.serial, ['shell', `input keyevent ${k}`]));
  return text(`Sent keyevent ${k}`);
}

module.exports = {
  screenshot, uiDump, tap, swipe, typeText, key,
  parseUiNodes, formatUiNodes, uiXmlFresh, screenshotPipeline,
};
