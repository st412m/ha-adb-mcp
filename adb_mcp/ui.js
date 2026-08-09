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

/**
 * uiautomator отдаёт XML, поэтому переводы строк и служебные символы в
 * подписях приезжают сущностями. 1.2.3: до этого они попадали в вывод сырыми —
 * `Если вам нравится X-plore,&#10;здесь можно...`. Числовые формы (&#10;,
 * &#x41;) раскрываем тоже, а `&amp;` — последним, иначе `&amp;lt;`
 * превратился бы в `<`.
 */
function decodeXmlEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
    const txt = decodeXmlEntities(attr('text'));
    const desc = decodeXmlEntities(attr('content-desc'));
    const rid = attr('resource-id');
    const focused = attr('focused') === 'true';
    if (!clickable && !txt && !desc && !focused) continue;
    if (!b) continue;
    nodes.push({
      text: txt, desc, resourceId: rid, clickable, focused, bounds,
      box: [+b[1], +b[2], +b[3], +b[4]],
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

/**
 * Способности ввода — ВЫВОДЯТСЯ с устройства, не угадываются по модели.
 *
 * В вики было записано, что «на Fire TV тап кликает по сфокусированному
 * элементу» — как особенность конкретной приставки. Проверка 08.08 показала,
 * что это свойство leanback-устройств вообще: `android.hardware.touchscreen`
 * НЕТ НИ НА ОДНОМ из трёх (Fire TV, Shield, TiVo) — везде только
 * `leanback_only`, а у Fire TV вдобавок `faketouch`. Поэтому признак берётся
 * из `pm list features`, а не из списка моделей: на Samsung SDK 33 тот же код
 * без изменений уходит в ветку тапа.
 */
async function deviceCaps(serial) {
  const out = (await adb(withSerial(serial, ['shell', 'pm list features']))).toString();
  const has = f => out.includes(`feature:${f}`);
  return {
    touchscreen: has('android.hardware.touchscreen'),
    faketouch: has('android.hardware.faketouch'),
    leanback: has('android.software.leanback') || has('android.software.leanback_only'),
  };
}

const norm = s => String(s || '').trim().toLowerCase();

/** Совпадение узла с запрошенными критериями. */
function nodeMatches(n, args) {
  const exact = args.exact === true || args.exact === 'true';
  const cmp = (hay, needle) => {
    const h = norm(hay), x = norm(needle);
    if (!x) return false;
    return exact ? h === x : h.includes(x);
  };
  if (args.resource_id) {
    // сравниваем и полный id, и хвост после '/'
    const rid = norm(n.resourceId), tail = norm(String(n.resourceId).split('/').pop());
    const want = norm(args.resource_id);
    if (!(exact ? (rid === want || tail === want) : (rid.includes(want) || tail.includes(want)))) return false;
  }
  // 1.2.1: `text` ищет и по text, и по content-desc. У лаунчера Fire TV
  // подписи лежат ТОЛЬКО в content-desc, и до этой правки text= не находил
  // там ничего — при том что список «видны сейчас» показывал искомое,
  // потому что печатался из (text || desc). Домен поиска и домен показа
  // обязаны совпадать. `desc` остаётся узким — только content-desc.
  if (args.text && !(cmp(n.text, args.text) || cmp(n.desc, args.text))) return false;
  if (args.desc && !cmp(n.desc, args.desc)) return false;
  return !!(args.resource_id || args.text || args.desc);
}

/**
 * Подпись узла. Контейнеры на ТВ-лаунчерах (view_app_card, item_view)
 * фокусируемы, но текста не несут — он лежит в дочернем узле. Иерархии у
 * нас нет (парсер плоский), поэтому потомок ищется геометрически: самый
 * маленький подписанный узел, целиком лежащий внутри рамки этого.
 */
function nodeLabel(n, nodes) {
  if (n.text) return n.text;
  if (n.desc) return n.desc;
  if (!nodes || !n.box) return '';
  let best = null;
  for (const c of nodes) {
    if (c === n || !c.box || !(c.text || c.desc)) continue;
    const b = c.box, o = n.box;
    if (b[0] < o[0] || b[1] < o[1] || b[2] > o[2] || b[3] > o[3]) continue;
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (!best || area < best.area) best = { area, label: c.text || c.desc };
  }
  return best ? best.label : '';
}

/**
 * Устойчивое тождество узла: bounds смещаются при скролле, текст нет.
 * 1.2.1: у безтекстовых контейнеров ключ был одинаковым для ВСЕХ карточек
 * экрана (`...view_app_card||`) — цель находилась не та. Добавлена подпись
 * из потомка, а если и её нет — рамка (хуже при скролле, но лучше коллизии).
 */
const nodeKey = (n, nodes) => {
  const label = nodeLabel(n, nodes);
  return `${n.resourceId}|${n.text}|${n.desc}|${label || n.bounds}`;
};

async function currentWindow(serial) {
  try {
    const o = (await adb(withSerial(serial, ['shell', 'dumpsys window 2>/dev/null | grep -m1 mCurrentFocus']))).toString();
    return o.trim();
  } catch { return ''; }
}

/**
 * Найти элемент по тексту / resource-id / content-desc и активировать его.
 *
 * Два режима, и выбор между ними выводится, а не задаётся:
 *  • есть touchscreen → обычный `input tap` по центру элемента;
 *  • leanback без touchscreen → обход DPAD'ом до фокуса на элементе,
 *    потом DPAD_CENTER. Тап по координатам там кликает по ТЕКУЩЕМУ
 *    фокусу, т.е. молча попадает не туда — худший вид отказа.
 *
 * Никакой шаг не считается успешным без проверки: после каждого
 * нажатия дамп снимается заново и сверяется, сдвинулся ли фокус. Если
 * фокус встал — честный отказ с отчётом, а не видимость успеха.
 */
async function findAndTap(args) {
  const serial = args.serial;
  if (!args.text && !args.resource_id && !args.desc)
    throw new Error('укажи хотя бы один критерий: text, resource_id или desc');

  const caps = await deviceCaps(serial);
  let nodes = parseUiNodes(await uiXmlFresh(serial));
  let hits = nodes.filter(n => nodeMatches(n, args));

  if (!hits.length) {
    // 1.2.2: подписи подтягиваются из потомков, поэтому контейнер и его
    // подпись давали ДВЕ одинаковые строки («Назад», «Назад»).
    // 1.2.3: ключ был «подпись|id», а у контейнера id обычно нет — пара
    // «контейнер без id + потомок с id» так и оставалась двумя строками
    // (`сб, 8 августа` и `сб, 8 августа [id=common_date]`). Схлопываем по
    // ОДНОЙ подписи, оставляя вариант с id: он информативнее. На поиск это
    // не влияет — список только показывается.
    const byLabel = new Map();
    for (const n of nodes) {
      const label = nodeLabel(n, nodes);
      if (!label) continue;
      const tail = n.resourceId ? n.resourceId.split('/').pop() : '';
      const prev = byLabel.get(label);
      if (prev === undefined) byLabel.set(label, tail);
      else if (!prev && tail) byLabel.set(label, tail);
    }
    const visible = [];
    for (const [label, tail] of byLabel) {
      visible.push(`  ${label}${tail ? ` [id=${tail}]` : ''}`);
      if (visible.length >= 40) break;
    }
    throw new Error(`Элемент не найден. Видны сейчас:\n${visible.join('\n') || '  (ничего с текстом)'}`);
  }

  // 1.2.2: то же самое, но уже по существу. Контейнер и лежащая внутри него
  // подпись — ОДИН элемент с точки зрения пользователя, а под критерий
  // попадали оба, и тул требовал index там, где выбирать не из чего.
  // Оставляем внешний кликабельный узел: именно к нему обход и поднимался бы.
  if (hits.length > 1) {
    hits = hits.filter(n => !hits.some(o =>
      o !== n && o.box && n.box &&
      nodeLabel(o, nodes) === nodeLabel(n, nodes) &&
      o.box[0] <= n.box[0] && o.box[1] <= n.box[1] &&
      o.box[2] >= n.box[2] && o.box[3] >= n.box[3] &&
      (o.clickable || !n.clickable) &&
      (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) > (n.box[2] - n.box[0]) * (n.box[3] - n.box[1])));
  }

  if (hits.length > 1 && args.index === undefined) {
    const list = hits.map((n, i) => `  [${i}] ${nodeLabel(n, nodes)} @(${n.x},${n.y})`).join('\n');
    throw new Error(`Под критерий попало ${hits.length} элементов — уточни запрос или задай index:\n${list}`);
  }
  let target = hits[Math.min(Number(args.index) || 0, hits.length - 1)];
  const targetLabel = nodeLabel(target, nodes) || nodeKey(target, nodes);

  // 1.2.1: на ТВ-лаунчерах подпись («Kinopub») лежит в нефокусируемом
  // banner_image, а фокус DPAD встаёт на объемлющий view_app_card. Ведя
  // обход к самой подписи, до неё не дойти никогда. Поэтому цель поднимается
  // до наименьшего кликабельного узла, который её содержит.
  if (!target.clickable && target.box) {
    let host = null;
    for (const c of nodes) {
      if (c === target || !c.clickable || !c.box) continue;
      const b = target.box, o = c.box;
      if (b[0] < o[0] || b[1] < o[1] || b[2] > o[2] || b[3] > o[3]) continue;
      const area = (o[2] - o[0]) * (o[3] - o[1]);
      if (!host || area < host.area) host = { area, node: c };
    }
    if (host) target = host.node;
  }
  let targetKey = nodeKey(target, nodes);
  const winBefore = await currentWindow(serial);

  // ── Путь с настоящим тачскрином ──
  if (caps.touchscreen) {
    await adb(withSerial(serial, ['shell', `input tap ${target.x} ${target.y}`]));
    const winAfter = await currentWindow(serial);
    return text(
      `Тап по «${targetLabel}» @(${target.x},${target.y}) — у устройства есть touchscreen.\n` +
      `Окно ${winAfter && winAfter !== winBefore ? 'сменилось' : 'НЕ сменилось (это нормально для внутриэкранных действий)'}`);
  }

  // ── leanback: обход DPAD'ом ──
  if (!caps.leanback)
    throw new Error('У устройства нет ни touchscreen, ни leanback — как активировать элемент, неизвестно. Отказ вместо слепого тапа.');

  // 1.2.1: дефолт снижен 20 → 12 и добавлен дедлайн по часам. Каждый шаг —
  // полный uiautomator dump (~1.5–2 с), поэтому 20 шагов не укладывались в
  // таймаут MCP-клиента: тул доходил до конца, а вызывающий видел
  // «server isn't responding» и не получал отчёта вообще.
  const maxSteps = Math.min(Math.max(Number(args.max_steps) || 12, 1), 40);
  const deadline = Date.now() + 25000;
  const trail = [];
  let stuck = 0;
  const visited = new Set();

  for (let step = 0; step < maxSteps; step++) {
    const cur = nodes.find(n => n.focused);
    if (!cur) {
      throw new Error(
        `Фокус на экране не найден — вести DPAD'ом не от чего. ` +
        `Нажми любую клавишу (adb_key DPAD_DOWN) и повтори.${trail.length ? ` Пройдено: ${trail.join(' ')}` : ''}`);
    }
    const curKey = nodeKey(cur, nodes);
    if (curKey === targetKey) break;

    // Зацикливание: фокус ходит по кругу между несколькими узлами (типично,
    // когда цель нефокусируема и обход бьётся об неё слева-справа). Прежний
    // детектор ловил только полную остановку — «фокус-то двигается».
    if (visited.has(curKey)) {
      throw new Error(
        `Фокус зациклился: вернулся на «${nodeLabel(cur, nodes) || '(без подписи)'}», уже пройденный на этом обходе ` +
        `(${trail.join(' ')}). Цель «${targetLabel}» недостижима обходом — скорее всего она нефокусируема. ` +
        `НИЧЕГО НЕ НАЖАТО.`);
    }
    visited.add(curKey);

    if (Date.now() > deadline) {
      throw new Error(
        `Обход прерван по времени (${trail.length} шагов: ${trail.join(' ')}), чтобы вернуть отчёт, ` +
        `а не молчание по таймауту. Сейчас в фокусе: «${nodeLabel(cur, nodes) || '(без подписи)'}», ` +
        `цель «${targetLabel}» не достигнута. НИЧЕГО НЕ НАЖАТО.`);
    }

    const dx = target.x - cur.x, dy = target.y - cur.y;
    const primary = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'DPAD_RIGHT' : 'DPAD_LEFT')
      : (dy > 0 ? 'DPAD_DOWN' : 'DPAD_UP');
    const secondary = Math.abs(dx) > Math.abs(dy)
      ? (dy > 0 ? 'DPAD_DOWN' : 'DPAD_UP')
      : (dx > 0 ? 'DPAD_RIGHT' : 'DPAD_LEFT');
    const dir = stuck === 0 ? primary : secondary;

    await adb(withSerial(serial, ['shell', `input keyevent ${dir}`]));
    trail.push(dir.replace('DPAD_', ''));
    await new Promise(r => setTimeout(r, 350));

    const prevKey = curKey;
    nodes = parseUiNodes(await uiXmlFresh(serial));
    const now = nodes.find(n => n.focused);
    // цель могла сместиться при скролле — переищем её по тексту
    const again = nodes.find(n => nodeKey(n, nodes) === targetKey);
    if (again) target = again;

    if (now && nodeKey(now, nodes) === prevKey) {
      stuck++;
      if (stuck >= 2)
        throw new Error(
          `Фокус не двигается ни по одной оси, остался на «${nodeLabel(now, nodes) || '(без подписи)'}». ` +
          `Цель «${targetLabel}» не достигнута за ${step + 1} шагов (${trail.join(' ')}). ` +
          `Ничего не нажато — веди вручную через adb_key.`);
    } else {
      stuck = 0;
    }
  }

  const finalFocus = nodes.find(n => n.focused);
  if (!finalFocus || nodeKey(finalFocus, nodes) !== targetKey)
    throw new Error(
      `За ${maxSteps} шагов фокус до цели не дошёл (${trail.join(' ')}). ` +
      `Сейчас в фокусе: «${finalFocus ? (nodeLabel(finalFocus, nodes) || '(без подписи)') : 'ничего'}». ` +
      `НИЧЕГО НЕ НАЖАТО. Увеличь max_steps или веди вручную.`);

  await adb(withSerial(serial, ['shell', 'input keyevent DPAD_CENTER']));
  await new Promise(r => setTimeout(r, 400));
  const winAfter = await currentWindow(serial);

  return text(
    `Активировано «${targetLabel}» через DPAD (устройство leanback, touchscreen нет).\n` +
    `Путь: ${trail.length ? trail.join(' → ') : 'уже было в фокусе'} → CENTER\n` +
    `Окно ${winAfter && winAfter !== winBefore ? 'сменилось' : 'НЕ сменилось (нормально для внутриэкранных действий)'}`);
}

module.exports = {
  screenshot, uiDump, tap, swipe, typeText, key, findAndTap,
  parseUiNodes, formatUiNodes, uiXmlFresh, screenshotPipeline,
  deviceCaps, nodeMatches, nodeKey, decodeXmlEntities,
};
