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
const { adb, withSerial, sq, text, escapeInputText, ADB_TIMEOUT_MS, ADB_MAX_BUFFER } = require('./adb.js');
const { resumedActivity } = require('./device.js');

// §3 спеки: пороги «равномерно тёмный» — стартовые значения, подбор на
// приёмке. Константы, а не магические числа в коде, — чтобы править в одном
// месте.
const DARK_MEAN_THRESHOLD = 0.03;
const DARK_SD_THRESHOLD = 0.01;

// §2 спеки: TTL снимка для coords="screenshot" — одна константа.
const SCREENSHOT_GEOM_TTL_MS = 120000;

/**
 * Часть шелл-конвейера ПОСЛЕ screencap: снять размеры исходника, сделать
 * resize+quality с записью JPEG, снять размеры и mean/sd уже уменьшенной
 * картинки — одна экспортируемая функция (ревизия 17.09 спеки, §2): смоук
 * `toolchain-check.sh` обязан гонять ЕЁ, а не собственную копию команды IM.
 * Копия проверяла бы дубликат, а не код, которым работает adb_screenshot.
 *
 * ⚠ 1.3.0, найдено при сборке dev-образа (magick 7.1.2.15, Alpine 3.22):
 * прежняя версия мешала в ОДНОМ вызове mid-sequence `-write JPGFILE` и
 * `-format ... info:`, а вызов для размеров оригинала кончался ПРОСТО
 * файлом без `info:` в конце. По грамматике magick («input filename(s)
 * ... zero or one output image filename», usage.imagemagick.org/basics/:
 * «you can also produce identify output ... using the special `info:`
 * output file format», и «As this is last argument, an implicit -write
 * operation is performed with this argument») голый файл, ОКАЗАВШИЙСЯ
 * ПОСЛЕДНИМ позиционным аргументом, magick трактует как ПУСТУЮ цель
 * записи, а не как источник чтения — отсюда `no images for write` и
 * молчаливое отсутствие маркеров @@W@@/@@H@@ при том, что @@w@@/@@h@@/
 * @@mean@@/@@sd@@ из первого вызова доходили нормально.
 *
 * Три вызова теперь СТРОГО раздельны, и оба идиома проверены независимо:
 * `identify`-через-`-format ... info:` (вызовы 1 и 3, файл ПЕРЕД `info:`
 * — обязательным вторым позиционным) и простейшая форма `INPUT [настройки]
 * OUTPUT` без -write и без info: (вызов 2 — тот же вид, что и проверенный
 * годами конвейер 1.2.5 и `smoke()` в этом файле). Смешивать их в одном
 * вызове больше не пытаемся.
 *
 * Геометрия и mean/sd уходят на stderr, размеченные маркерами вида
 * `@@key@@значение` (тот же приём, что splitMarked в device.js) — stdout
 * несёт ТОЛЬКО байты JPEG (см. screenshotPipeline), а stderr уже занят
 * предупреждениями IM (`deprecated in IMv7`), так что смешивать текст со
 * значениями без разметки было бы гонкой за «последней строкой».
 *
 * pngTok/jpgTok — уже готовые для вставки в shell-строку токены (обычно
 * `"$T/s.png"` — переменная шелла, а не JS-значение), сама функция их не
 * квотирует: квотирование значений из JS (px, формат-строка) — через sqq.
 */
function buildImagePipeline(pngTok, jpgTok, px, q) {
  const sqq = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const fmtOrig = sqq('@@W@@%w\n@@H@@%h\n');
  const fmtResized = sqq('@@w@@%w\n@@h@@%h\n@@mean@@%[fx:mean]\n@@sd@@%[fx:standard_deviation]\n');
  return (
    // 1. Размеры ИСХОДНИКА — до какого-либо resize.
    `"$IM" -format ${fmtOrig} ${pngTok} info: 1>&2 || exit 99; ` +
    // 2. resize + quality, запись JPEG.
    `"$IM" ${pngTok} -resize ${sqq(px + 'x' + px + '>')} -quality ${q} ${jpgTok} || exit 99; ` +
    // 3. Размеры и mean/sd уже уменьшенной картинки — читаем только что
    //    записанный JPEG (те самые байты, что уйдут в ответ), а не
    //    промежуточное состояние из вызова 2.
    `"$IM" -format ${fmtResized} ${jpgTok} info: 1>&2 || exit 99`
  );
}

/**
 * Разбор маркированного вывода buildImagePipeline. По той же причине, что
 * splitMarked в device.js: разбор по СТРОКАМ-МАРКЕРАМ, а не по позиции —
 * посторонняя строка (предупреждение IM) просто не совпадает с шаблоном и
 * пропускается, а не сдвигает поля. Любое поле, которое не удалось
 * разобрать, — null, а не 0 и не догадка: 0 — валидный, хоть и странный,
 * результат fx:mean.
 */
function parseGeometry(raw) {
  const map = {};
  const re = /^@@([a-zA-Z]+)@@(.*)$/;
  for (const line of String(raw || '').split('\n')) {
    const m = re.exec(line.trim());
    if (m) map[m[1]] = m[2].trim();
  }
  const num = v => {
    if (v === undefined) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const W = num(map.W), H = num(map.H), w = num(map.w), h = num(map.h);
  const mean = num(map.mean), sd = num(map.sd);
  const sx = (W && w) ? W / w : null;
  const sy = (H && h) ? H / h : null;
  return {
    W, H, w, h, mean, sd, sx, sy,
    dark: (mean !== null && sd !== null) ? (mean < DARK_MEAN_THRESHOLD && sd < DARK_SD_THRESHOLD) : null,
  };
}

/**
 * §2 спеки, ревизия 18.09 (приёмка на Shield и Fire TV): `wm size` отдаёт
 * `Override size: WxH` ОТДЕЛЬНО от `Physical size: WxH`, когда системе
 * задан логический размер экрана, отличный от физического буфера
 * `screencap`. Факт с обоих устройств: Physical 3840x2160 / Override
 * 1920x1080, а `input tap` и `uiautomator` работают именно в Override —
 * тап по физическим (удвоенным) координатам НЕ попадает. TiVo Stream 4K
 * строки Override не выдаёт вовсе — там Physical и есть единственное и
 * логическое пространство. Разбор построчный: порядок строк не гарантирован,
 * Override может отсутствовать, а искать позиционно — тот же класс ошибки,
 * что уже чинился в device.js (locale, 1.1.1).
 */
function parseWmSize(raw) {
  const text = String(raw || '');
  const phys = /Physical size:\s*(\d+)x(\d+)/.exec(text);
  const over = /Override size:\s*(\d+)x(\d+)/.exec(text);
  const physical = phys ? { w: +phys[1], h: +phys[2] } : null;
  const override = over ? { w: +over[1], h: +over[2] } : null;
  return { physical, override, logical: override || physical };
}

/**
 * Свести PNG-кадр (screencap) и `wm size` в размер, в котором работают
 * `input tap`/`uiautomator` — то, что показывается как «screen» и в чём
 * зажимаются координаты `coords="screenshot"`.
 *
 * Override, если он есть, БЕРЁТСЯ ВСЕГДА вместо Physical — это и есть
 * логическое пространство ввода (приёмка 18.09). `wm size` не распарсился —
 * честный фолбэк на размер кадра (старое поведение до этой правки), а не
 * молчаливое умножение на случайный коэффициент; фолбэк помечается флагом
 * и обязан показаться в тексте ответа, а не спрятаться.
 *
 * Ориентация сверяется по PNG — реальному захваченному кадру, источнику
 * истины о текущей ориентации экрана: если PNG landscape, а логический
 * размер portrait (или наоборот), логические W/H меняются местами. PNG
 * не трогается — переворачивать его не наша забота.
 */
function reconcileScreenSize(frameW, frameH, wmsize) {
  const logical = wmsize && wmsize.logical;
  if (!logical) return { screenW: frameW, screenH: frameH, frameW, frameH, fallback: true };

  let { w, h } = logical;
  const frameLandscape = frameW >= frameH;
  const logicalLandscape = w >= h;
  if (frameLandscape !== logicalLandscape) { const t = w; w = h; h = t; }

  return { screenW: w, screenH: h, frameW, frameH, fallback: false };
}

function screenshotPipeline(serial, px, q) {
  return new Promise((resolve, reject) => {
    const sqq = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
    const sArg = serial ? `-s ${sqq(serial)} ` : '';
    const cmd =
      `IM=convert; command -v magick >/dev/null 2>&1 && IM=magick; ` +
      `T=$(mktemp -d) || exit 96; trap 'rm -rf "$T"' EXIT; ` +
      // §2 (приёмка 18.09): wm size — СВЕЖИЙ на каждый снимок, не кешируется:
      // Override меняется на лету (переключение режима дисплея под контент
      // на Shield), соотношение кадр/ввод непостоянно даже между двумя
      // соседними снимками. Отдельный вызов adb, но в ТОМ ЖЕ шелл-скрипте —
      // не отдельный обмен на уровне тула. Сбой не должен ронять скриншот —
      // поэтому без `|| exit`; честный фолбэк на размер кадра разбирается
      // в JS (reconcileScreenSize), а не молчанием здесь.
      `adb ${sArg}shell 'wm size' > "$T/wmsize.txt" 2>&1; cat "$T/wmsize.txt" 1>&2; ` +
      `adb ${sArg}exec-out screencap -p > "$T/s.png" || exit 97; ` +
      `[ -s "$T/s.png" ] || exit 98; ` +
      `${buildImagePipeline('"$T/s.png"', '"$T/s.jpg"', px, q)}; ` +
      `cat "$T/s.jpg"`;
    execFile('sh', ['-c', cmd], {
      timeout: ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
      encoding: 'buffer',
    }, (err, stdout, stderr) => {
      const stderrStr = (stderr || '').toString();
      const errTxt = stderrStr.split('\n')
        .filter(l => l.trim() && !/deprecated in IMv7/i.test(l) && !/^@@/.test(l.trim()))
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
      resolve({ data: stdout.toString('base64'), geom: parseGeometry(stderrStr), wmsize: parseWmSize(stderrStr) });
    });
  });
}

// Геометрия последнего снимка ПО УСТРОЙСТВУ — источник для coords="screenshot"
// у adb_tap/adb_swipe. Ключ — как в uiXmlFresh (serial || '_default'): снимок
// без serial и тап С serial иначе указывали бы на разные записи для одного
// физического устройства.
const lastScreenshotGeom = new Map();
const geomKey = serial => serial || '_default';

/** dumpsys power отдаёт mWakefulness=Awake|Asleep|Dozing|Dreaming. Сбой —
 *  null, а не догадка (используется и в тексте предупреждения §3, и в
 *  тексте ошибки 98). */
async function wakefulness(serial) {
  try {
    const out = (await adb(withSerial(serial, ['shell', 'dumpsys power 2>/dev/null | grep -m1 mWakefulness=']))).toString();
    const m = out.match(/mWakefulness=(\w+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Команда, снимающая ОДНУ строку fl= окна В ФОКУСЕ. Дамп `dumpsys window
 * windows` целиком в Node не тащим — сотни КБ на телефоне — фильтруем на
 * устройстве. Хэш окна в фокусе ищется по mCurrentFocus ГДЕ УГОДНО в выводе
 * (sed сканирует весь текст, а не первую строку). Само fl= ищется ТОЛЬКО в
 * блоке, чей заголовок содержит и `Window #`, и `Window{<hash> ` (пробел
 * после хэша — иначе более короткий хэш совпадёт как подстрока более
 * длинного, и мы попадём не в тот блок: mCurrentFocus/mFocusedApp тоже
 * содержат «Window{<hash> ...}», но это не заголовок блока). Если раньше
 * fl= встретился заголовок СЛЕДУЮЩЕГО окна — блок кончился без fl=, вывод
 * пуст → «не определено», а не 0 случайно совпавших строк.
 */
function buildSecureFlagCmd() {
  return (
    'F=$(dumpsys window windows 2>/dev/null | sed -n "s/.*mCurrentFocus=Window{\\([0-9a-f]*\\) .*/\\1/p" | head -1); ' +
    '[ -n "$F" ] && dumpsys window windows 2>/dev/null | awk -v f="$F" \'' +
      '$0 ~ /Window #/ && index($0, "Window{" f " ") { phase=1; next } ' +
      'phase==1 && / fl=/ { print; exit } ' +
      'phase==1 && $0 ~ /Window #/ { exit }' +
    '\''
  );
}

/**
 * ⚠ Разбор значения fl= — формат НЕ СВЕРЕН ни на одном SDK (§3 спеки), поэтому
 * распознаются только ДВА конкретных вида, и любой третий — null, а не false:
 *  · числовой (`fl=#<hex>` или `fl=0x<hex>`) — FLAG_SECURE это бит 0x00002000;
 *  · именной (флаги через `,`/`|`/`[...]`) — SECURE ищется как ОТДЕЛЬНЫЙ
 *    токен, а не подстрокой (иначе, скажем, `INSECURE_KEYGUARD` дал бы
 *    ложное совпадение).
 */
function parseSecureFlag(line) {
  const m = /\bfl=(\S+)/.exec(String(line || ''));
  if (!m) return null;
  const v = m[1].replace(/[,;]+$/, '');

  if (/^#[0-9a-fA-F]+$/.test(v)) return !!(parseInt(v.slice(1), 16) & 0x00002000);
  if (/^0x[0-9a-fA-F]+$/i.test(v)) return !!(parseInt(v.slice(2), 16) & 0x00002000);

  if (/[A-Z]/.test(v) && /^[A-Z0-9_|,[\]]+$/.test(v)) {
    const tokens = v.split(/[|,[\]]+/).filter(Boolean);
    return tokens.includes('SECURE');
  }

  return null; // неопознанный вид — не гадаем
}

async function secureWindowFlag(serial) {
  try {
    const out = (await adb(withSerial(serial, ['shell', buildSecureFlagCmd()]))).toString();
    return parseSecureFlag(out);
  } catch { return null; }
}

/**
 * Текст предупреждения о тёмном кадре (§3). Вызывается ТОЛЬКО когда
 * geom.dark === true — на обычный кадр это ни одного лишнего adb-вызова.
 * Каждая улика опциональна: сбой любой из них — просто её нет в тексте,
 * а не отказ и не догадка за неё.
 */
async function darknessWarning(serial, geom) {
  const meanTxt = geom.mean !== null ? geom.mean.toFixed(3) : '?';
  const sdTxt = geom.sd !== null ? geom.sd.toFixed(3) : '?';
  const wake = await wakefulness(serial).catch(() => null);
  const secure = await secureWindowFlag(serial).catch(() => null);

  const parts = [];
  if (wake) parts.push(`screen: ${wake}`);
  if (secure === true) parts.push('focused window has FLAG_SECURE, content hidden by the system');
  else if (secure === false) parts.push('no protection flag found, the frame may genuinely be black');
  // secure === null — не определено, без догадок, ничего не добавляем.

  return `⚠ frame is almost uniformly dark (mean ${meanTxt}, sd ${sdTxt}).${parts.length ? ' ' + parts.join(', ') : ''}`;
}

async function screenshot(args) {
  const q = Math.min(Math.max(Math.round(args.quality || 70), 30), 95);
  const px = Math.min(Math.max(Math.round(args.max_px || 1024), 320), 1920);
  const serial = args.serial;

  let data, geom, wmsize;
  try {
    const r = await screenshotPipeline(serial, px, q);
    data = r.data; geom = r.geom; wmsize = r.wmsize;
  } catch (e) {
    // §3: код 98 (пустой кадр) — добавляем mWakefulness, если удалось
    // прочитать. Отдельный adb-вызов НЕ нарушает «лишний adb не нужен» из
    // §3 — та оговорка про mean/sd обычного кадра, а здесь кадра не было
    // вовсе, и конвейер выше не смог бы снять это сам.
    if (/screencap produced no data/i.test(e.message)) {
      const wake = await wakefulness(serial).catch(() => null);
      if (wake) throw new Error(`${e.message} (mWakefulness=${wake})`);
    }
    throw e;
  }

  let scaleTxt;
  if (geom && geom.W && geom.H && geom.w && geom.h) {
    // §2 (приёмка 18.09): input tap и uiautomator работают в ЛОГИЧЕСКОМ
    // размере (wm size Override, если есть, иначе Physical), а не в размере
    // PNG-кадра screencap. На Shield/Fire TV PNG физически 3840x2160 при
    // логическом 1920x1080 — масштаб по PNG завышал его вдвое, и
    // coords="screenshot" промахивался бы ровно с таким коэффициентом.
    const rec = reconcileScreenSize(geom.W, geom.H, wmsize);
    const sx = rec.screenW / geom.w;
    const sy = rec.screenH / geom.h;

    lastScreenshotGeom.set(geomKey(serial),
      { W: rec.screenW, H: rec.screenH, w: geom.w, h: geom.h, sx, sy, ts: Date.now() });

    // «Кадр» показывается ОТДЕЛЬНО и ТОЛЬКО когда он отличается от
    // логического размера — на TiVo Stream 4K (только Physical, без
    // Override) они совпадают, и лишняя строка была бы шумом.
    const frameNote = (rec.frameW !== rec.screenW || rec.frameH !== rec.screenH)
      ? ` (frame ${rec.frameW}x${rec.frameH})` : '';
    // wm size не распарсился — честный фолбэк на размер кадра, ПОМЕЧЕННЫЙ
    // в тексте, а не тихая подстановка без предупреждения.
    const fallbackNote = rec.fallback
      ? ' ⚠ wm size did not parse, the frame size is used - coordinates may not match input tap' : '';

    scaleTxt = `screen ${rec.screenW}x${rec.screenH}${frameNote} -> image ${geom.w}x${geom.h} · scale ${sx.toFixed(3)}/${sy.toFixed(3)} · ` +
      `pass coords="screenshot" to adb_tap/adb_swipe${fallbackNote}`;
  } else {
    // Честно: геометрия не разобралась (неожиданный вывод IM на этой сборке) —
    // coords="screenshot" для этого кадра недоступен, а не подставляется наугад.
    scaleTxt = `frame geometry not determined - use coords="screen" (the default) for adb_tap/adb_swipe`;
  }

  const warnTxt = (geom && geom.dark === true) ? '\n' + await darknessWarning(serial, geom) : '';

  return [
    { type: 'image', data, mimeType: 'image/jpeg' },
    { type: 'text', text: scaleTxt + warnTxt },
  ];
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
    // §6 1.3.0: поле пароля попадает в список ДАЖЕ без clickable/text/desc —
    // иначе поле ввода пароля в дампе просто не видно. Логику поиска
    // (nodeMatches) это не трогает, password только добавлен в узел.
    const password = attr('password') === 'true';
    if (!clickable && !txt && !desc && !focused && !password) continue;
    if (!b) continue;
    nodes.push({
      text: txt, desc, resourceId: rid, clickable, focused, password, bounds,
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
    `${n.clickable ? '[BTN]' : '[TXT]'}${n.focused ? '[FOCUSED]' : ''}${n.password ? '[PASSWORD]' : ''} ` +
    `${n.text || n.desc || (n.password ? '(password field)' : '(no text)')}` +
    `${n.resourceId ? ` id=${n.resourceId.split('/').pop()}` : ''}` +
    ` @(${n.x},${n.y}) bounds=${n.bounds}`
  ).join('\n');
}

// v0.2.1: uiautomator может отдать устаревший дамп сразу после смены экрана
const lastUiDumpHash = new Map();

/**
 * 1.3.0 (§5 спеки, ревизия 17.09): имя файла дампа теперь СЛУЧАЙНОЕ, а не
 * общий /sdcard/adbmcp_ui.xml. Параллельные вызовы клиента писали бы в один
 * файл — гонка, которая при verify=ui утраивает число дампов за один вызов
 * тула и утраивает шанс столкновения. Удаление — в finally, а не строкой
 * после cat: сбой между dump и rm раньше оставлял мусор на sdcard навечно.
 */
async function dumpXml(serial) {
  const p = `/sdcard/adbmcp_ui_${crypto.randomBytes(4).toString('hex')}.xml`;
  try {
    const st = (await adb(withSerial(serial, ['shell', `uiautomator dump ${sq(p)} 2>&1`]))).toString();
    if (!/dumped to/i.test(st) && /error/i.test(st)) throw new Error(`uiautomator: ${st.trim()}`);
    return (await adb(withSerial(serial, ['shell', `cat ${sq(p)}`]))).toString();
  } finally {
    await adb(withSerial(serial, ['shell', `rm -f ${sq(p)}`])).catch(() => {});
  }
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

/**
 * §2 спеки: coords="screen" (по умолчанию, поведение 1.2.5 без изменений)
 * или coords="screenshot" — координаты с картинки adb_screenshot,
 * пересчитанные через запомненный масштаб. Отказ, если снимка для этого
 * ключа нет или он старше SCREENSHOT_GEOM_TTL_MS: угадывать масштаб хуже,
 * чем отказать. Поворот между снимком и тапом НЕ проверяется — записано в
 * описании тула, а не молчаливое допущение здесь.
 */
function resolveCoord(coordsMode, x, y, serial) {
  const mode = coordsMode === 'screenshot' ? 'screenshot' : 'screen';
  if (mode === 'screen') return { x: Math.round(x), y: Math.round(y), note: '' };

  const g = lastScreenshotGeom.get(geomKey(serial));
  if (!g || (Date.now() - g.ts) > SCREENSHOT_GEOM_TTL_MS)
    throw new Error(
      'the screenshot is stale or was never taken - call adb_screenshot. ' +
      'Pass serial the same way as in adb_screenshot: a screenshot without serial and a tap with serial are different keys.');

  const xi = Math.round(x), yi = Math.round(y);
  const xOut = Math.min(Math.max(Math.round(xi * g.sx), 0), g.W - 1);
  const yOut = Math.min(Math.max(Math.round(yi * g.sy), 0), g.H - 1);
  return { x: xOut, y: yOut, note: ` - from screenshot coordinates (${xi},${yi}) × ${g.sx.toFixed(3)}/${g.sy.toFixed(3)}` };
}

/**
 * §5 спеки: verify детерминированно воссоздаёт то, что у roubao делает
 * отдельный вызов VLM (сравнение «до/после»). Сбой САМОЙ проверки НИКОГДА
 * не превращает выполненное действие в ошибку — `act()` уже отработал к
 * моменту, когда что-то в проверке могло сломаться.
 */
async function runVerify(serial, mode, act) {
  if (mode !== 'activity' && mode !== 'ui') {
    await act();
    return { note: '', changed: null };
  }

  const safe = async fn => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  const beforeR = await safe(() => resumedActivity(serial));
  const xmlBeforeR = mode === 'ui' ? await safe(() => dumpXml(serial)) : null;

  await act();
  await new Promise(r => setTimeout(r, 700));

  const afterR = await safe(() => resumedActivity(serial));

  const comp = r => (r && r.ok && r.value.component) ? r.value.component : null;
  const b = comp(beforeR), a = comp(afterR);
  let activityTxt;
  if (!beforeR.ok && !afterR.ok) activityTxt = `resumed: unknown (${afterR.error || beforeR.error})`;
  else if (b === null || a === null) activityTxt = 'resumed: unknown';
  else if (b === a) activityTxt = `resumed: unchanged (${b})`;
  else activityTxt = `resumed: ${b} -> ${a}`;

  if (mode === 'activity') return { note: ` · ${activityTxt}`, changed: null };

  if (!xmlBeforeR.ok)
    return { note: ` · ${activityTxt} · ui: unknown (${xmlBeforeR.error})`, changed: null };

  let xmlAfterR = await safe(() => dumpXml(serial));
  if (!xmlAfterR.ok)
    return { note: ` · ${activityTxt} · ui: unknown (${xmlAfterR.error})`, changed: null };

  let changed = hashUiXml(xmlBeforeR.value) !== hashUiXml(xmlAfterR.value);
  if (!changed) {
    // Хэши совпали — анимация могла не закончиться, даём ей время и повторяем ОДИН раз.
    await new Promise(r => setTimeout(r, 600));
    const retryR = await safe(() => dumpXml(serial));
    if (retryR.ok) changed = hashUiXml(xmlBeforeR.value) !== hashUiXml(retryR.value);
  }
  return { note: ` · ${activityTxt} · ui: ${changed ? 'changed' : 'unchanged'}`, changed };
}

/**
 * Нормализация дампа перед хэшем: узлы `package="com.android.systemui"`
 * выбрасываются целиком — иначе часы в статус-баре дают ложное «изменился»
 * при КАЖДОМ verify=ui. Фокус и выделение НЕ выбрасываются: для DPAD это и
 * есть само изменение, которое verify обязан увидеть.
 */
function normalizeUiXmlForHash(xml) {
  return String(xml || '').replace(/<node[^>]*\/?>/g, tag =>
    /\bpackage="com\.android\.systemui"/.test(tag) ? '' : tag);
}

function hashUiXml(xml) {
  return crypto.createHash('md5').update(normalizeUiXmlForHash(xml)).digest('hex');
}

async function tap(args) {
  const c = resolveCoord(args.coords, args.x, args.y, args.serial);
  const v = await runVerify(args.serial, args.verify,
    () => adb(withSerial(args.serial, ['shell', `input tap ${c.x} ${c.y}`])));
  return text(`Tapped (${c.x}, ${c.y})${c.note}${v.note}`);
}

async function swipe(args) {
  const c1 = resolveCoord(args.coords, args.x1, args.y1, args.serial);
  const c2 = resolveCoord(args.coords, args.x2, args.y2, args.serial);
  const d = args.duration_ms || 300;
  const v = await runVerify(args.serial, args.verify,
    () => adb(withSerial(args.serial, ['shell', `input swipe ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${Math.round(d)}`])));
  // §5: у свайпа «не изменился» отдельно означает конец списка — модели это
  // не всегда очевидно без подсказки, у тапа такой смысловой связки нет.
  const scrollHint = (v.changed === false) ? ' (for a scroll this usually means the end of the list)' : '';
  const note = c1.note || c2.note;
  return text(`Swiped (${c1.x},${c1.y}) -> (${c2.x},${c2.y}) in ${d}ms${note}${v.note}${scrollHint}`);
}

async function typeText(args) {
  const serial = args.serial;
  const t = String(args.text);
  if (/^[\x20-\x7E]*$/.test(t)) {
    await adb(withSerial(serial, ['shell', `input text "${escapeInputText(t)}"`]));
    // §1 1.3.0: раньше здесь эхом уходил сам текст — включая пароли, если
    // они набирались через adb_text вместо adb_shell input text. Модель
    // аргумент и так знает, повторять его в ответе незачем.
    return text(`Typed ${t.length} chars (ASCII)`);
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
  return text(`Typed ${t.length} chars (unicode via ADBKeyBoard)`);
}

async function key(args) {
  const k = /^\d+$/.test(args.key) ? args.key : `KEYCODE_${args.key.toUpperCase().replace(/^KEYCODE_/, '')}`;
  const v = await runVerify(args.serial, args.verify,
    () => adb(withSerial(args.serial, ['shell', `input keyevent ${k}`])));
  return text(`Sent keyevent ${k}${v.note}`);
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
    throw new Error('pass at least one criterion: text, resource_id or desc');

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
    throw new Error(`Element not found. Visible now:\n${visible.join('\n') || '  (nothing with a label)'}`);
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
    throw new Error(`${hits.length} elements match the criteria - narrow the query or pass index:\n${list}`);
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
      `Tapped "${targetLabel}" @(${target.x},${target.y}) - the device has a touchscreen.\n` +
      `Window ${winAfter && winAfter !== winBefore ? 'changed' : 'did NOT change (normal for in-screen actions)'}`);
  }

  // ── leanback: обход DPAD'ом ──
  if (!caps.leanback)
    throw new Error('The device reports neither touchscreen nor leanback - there is no known way to activate the element. Refused instead of tapping blind.');

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
        `No focused element on screen - there is nothing to walk from. ` +
        `Press any key (adb_key DPAD_DOWN) and retry.${trail.length ? ` Walked: ${trail.join(' ')}` : ''}`);
    }
    const curKey = nodeKey(cur, nodes);
    if (curKey === targetKey) break;

    // Зацикливание: фокус ходит по кругу между несколькими узлами (типично,
    // когда цель нефокусируема и обход бьётся об неё слева-справа). Прежний
    // детектор ловил только полную остановку — «фокус-то двигается».
    if (visited.has(curKey)) {
      throw new Error(
        `Focus is cycling: back on "${nodeLabel(cur, nodes) || '(no label)'}", already visited on this walk ` +
        `(${trail.join(' ')}). Target "${targetLabel}" cannot be reached by walking - it is most likely not focusable. ` +
        `Nothing was pressed.`);
    }
    visited.add(curKey);

    if (Date.now() > deadline) {
      throw new Error(
        `Walk stopped on its time budget after ${trail.length} step${trail.length === 1 ? '' : 's'} (${trail.join(' ')}), ` +
        `so a report is returned instead of a timeout. Focused now: "${nodeLabel(cur, nodes) || '(no label)'}", ` +
        `target "${targetLabel}" not reached. Nothing was pressed.`);
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
          `Focus does not move on either axis, still on "${nodeLabel(now, nodes) || '(no label)'}". ` +
          `Target "${targetLabel}" not reached in ${step + 1} step${step === 0 ? '' : 's'} (${trail.join(' ')}). ` +
          `Nothing was pressed - walk manually with adb_key.`);
    } else {
      stuck = 0;
    }
  }

  const finalFocus = nodes.find(n => n.focused);
  if (!finalFocus || nodeKey(finalFocus, nodes) !== targetKey)
    throw new Error(
      `Focus did not reach the target in ${maxSteps} steps (${trail.join(' ')}). ` +
      `Focused now: "${finalFocus ? (nodeLabel(finalFocus, nodes) || '(no label)') : 'nothing'}". ` +
      `Nothing was pressed. Raise max_steps or walk manually.`);

  await adb(withSerial(serial, ['shell', 'input keyevent DPAD_CENTER']));
  await new Promise(r => setTimeout(r, 400));
  const winAfter = await currentWindow(serial);

  return text(
    `Activated "${targetLabel}" via DPAD (leanback device, no touchscreen).\n` +
    `Path: ${trail.length ? trail.join(' -> ') : 'already focused'} -> CENTER\n` +
    `Window ${winAfter && winAfter !== winBefore ? 'changed' : 'did NOT change (normal for in-screen actions)'}`);
}

module.exports = {
  screenshot, uiDump, tap, swipe, typeText, key, findAndTap,
  parseUiNodes, formatUiNodes, uiXmlFresh, screenshotPipeline,
  deviceCaps, nodeMatches, nodeKey, decodeXmlEntities,
  // 1.3.0: экспортируется для смоука toolchain-check.sh (§2 спеки — та же
  // функция, не копия команды) и для юнит-проверок без устройства.
  buildImagePipeline, parseGeometry, hashUiXml, normalizeUiXmlForHash,
  resolveCoord, dumpXml, buildSecureFlagCmd, parseSecureFlag,
  parseWmSize, reconcileScreenSize,
  DARK_MEAN_THRESHOLD, DARK_SD_THRESHOLD, SCREENSHOT_GEOM_TTL_MS,
};
