'use strict';
/**
 * files.js — установка/удаление APK и обмен файлами с устройством.
 *
 * ── Поддержка бандлов `.apks` (1.2.0) ─────────────────────────────────────
 *
 * Повод: после заводского сброса Fire TV 25.07 X-plore пришлось ставить
 * руками через `pm install-create/write/commit`, потому что `adb install`
 * бандл не принимает, а распаковать его на устройстве нельзя — на Fire OS 7
 * нет `unzip`. Теперь бандл распаковывается на стороне аддона, а сплиты
 * выбираются по ФАКТИЧЕСКИМ свойствам устройства.
 *
 * ⚠ Почему разбор ZIP свой, а не через `unzip`: в контейнер аддона ставятся
 * только nodejs, android-tools и imagemagick (см. Dockerfile) — `unzip` в
 * списке НЕТ. В Alpine есть busybox-applet, но полагаться на него нельзя, а
 * тянуть ещё один пакет ради одной операции незачем: `.apks` это обычный ZIP,
 * а `zlib` в Node уже есть. Никакой новой зависимости.
 *
 * ⚠ Конвенций именования сплитов НЕСКОЛЬКО, и поддержаны все три — иначе
 * инструмент работает ровно на тех бандлах, на которых его писали:
 *   bundletool  splits/base-master.apk, base-arm64_v8a.apk, base-ru.apk
 *   APKMirror   com.foo.apk + config.arm64_v8a.apk + config.ru.apk
 *   с устройства base.apk + split_config.arm64_v8a.apk
 * Реальный бандл X-plore в /media/VAULT/apk/ — второй вариант.
 *
 * ⚠ Ошибка в выборе ABI ФАТАЛЬНА (приложение не запустится), ошибка в
 * плотности — нет: сплиты плотности отказывают мягко, ресурс берётся из
 * базового APK. Установлено на живом устройстве 07.08: у X-plore на Fire TV
 * стоит `config.tvdpi` при корзине xhdpi, и приложение работает. Поэтому ABI
 * без совпадения — отказ, а плотность без совпадения — просто пропуск.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { adb, withSerial, text, coerceArray, resolveSafeHostPath } = require('./adb.js');
const { getProps } = require('./device.js');

const BUNDLE_EXT = /\.(apks|xapk|apkm)$/i;

// Корзины плотности Android. tvdpi намеренно на месте — именно она всплыла
// на Fire TV.
const DENSITY_BUCKETS = {
  ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240,
  xhdpi: 320, xxhdpi: 480, xxxhdpi: 640,
};
const DENSITY_ANY = new Set(['nodpi', 'anydpi']);

const KNOWN_ABIS = new Set([
  'armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64', 'mips', 'mips64',
]);

const normAbi = s => String(s || '').replace(/_/g, '-').replace(/^x86-64$/, 'x86_64');

// ───────────────────────── минимальный ZIP-ридер ─────────────────────────

function findEOCD(buf) {
  const maxBack = Math.min(buf.length, 65557); // 22 + максимальный комментарий
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Перечислить записи ZIP по центральному каталогу. */
function zipEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('не похоже на ZIP: не найден End of Central Directory');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff)
    throw new Error('ZIP64-бандлы не поддерживаются');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50)
      throw new Error(`повреждён центральный каталог ZIP на записи ${i}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, local });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function zipRead(buf, e) {
  if (buf.readUInt32LE(e.local) !== 0x04034b50)
    throw new Error(`повреждён локальный заголовок: ${e.name}`);
  const nameLen = buf.readUInt16LE(e.local + 26);
  const extraLen = buf.readUInt16LE(e.local + 28);
  const start = e.local + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`неподдерживаемый метод сжатия ${e.method} у ${e.name}`);
}

// ──────────────────── классификация и выбор сплитов ────────────────────

/**
 * Вытащить квалификатор сплита из имени файла.
 * Возвращает null для базового APK (он же master / universal).
 */
function qualifierOf(entryName) {
  const file = entryName.split('/').pop();
  const stem = file.replace(/\.apk$/i, '');

  // base.apk / <pkg>.apk / universal.apk / *-master.apk — базовые
  if (/^(base|universal)$/i.test(stem)) return null;
  if (/-master$/i.test(stem)) return null;

  // config.<q> / split_config.<q> / split_config_<q>
  let m = /(?:^|[._-])config[._-](.+)$/i.exec(stem);
  if (m) return m[1];

  // bundletool: <module>-<q>
  m = /^[A-Za-z0-9_]+-(.+)$/.exec(stem);
  if (m) return m[1];

  return null; // имя пакета целиком => база
}

function classify(q) {
  if (!q) return { kind: 'base' };
  const abi = normAbi(q);
  if (KNOWN_ABIS.has(abi)) return { kind: 'abi', value: abi };
  const low = q.toLowerCase();
  if (DENSITY_BUCKETS[low] !== undefined) return { kind: 'density', value: low };
  if (DENSITY_ANY.has(low)) return { kind: 'density_any', value: low };
  // локаль: ru, en, pt_BR, b+sr+Latn
  if (/^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(q) || /^b\+/.test(q))
    return { kind: 'locale', value: q.replace(/^b\+/, '').replace(/\+/g, '-') };
  return { kind: 'unknown', value: q };
}

/**
 * Выбрать сплиты под конкретное устройство.
 * props — то, что отдаёт device.getProps (abilist/density/locale).
 */
function chooseSplits(names, props, opts = {}) {
  const items = names.map(n => ({ name: n, ...classify(qualifierOf(n)) }));

  const bases = items.filter(i => i.kind === 'base');
  const chosen = [];
  const notes = [];

  // universal.apk сам по себе — это standalone-сборка, сплиты не нужны
  const universal = names.find(n => /(^|\/)universal\.apk$/i.test(n));
  const hasSplits = items.some(i => ['abi', 'density', 'locale'].includes(i.kind));
  if (universal && !hasSplits) {
    return { chosen: [universal], notes: ['в бандле только universal.apk — ставится как обычный APK'], items };
  }

  if (!bases.length) throw new Error('в бандле не найден базовый APK (base/master/<пакет>.apk)');
  // Все master-модули (feature modules времени установки) идут целиком
  chosen.push(...bases.map(b => b.name));

  // ── ABI: ошибка здесь фатальна, поэтому при промахе отказываем ──
  const abiItems = items.filter(i => i.kind === 'abi');
  if (abiItems.length) {
    const want = (opts.abi ? [normAbi(opts.abi)] : (props.abilist || []).map(normAbi));
    const hit = want.map(a => abiItems.find(i => i.value === a)).find(Boolean);
    if (!hit) {
      throw new Error(
        (opts.abi
          ? `в бандле нет сплита под запрошенный ABI «${opts.abi}» (устройство сообщает: ${(props.abilist || []).join(', ') || 'ABI не определён'}). `
          : `в бандле нет сплита ни под один ABI устройства (${(props.abilist || []).join(', ') || 'ABI не определён'}). `) +
        `Есть: ${abiItems.map(i => i.value).join(', ')}. Установка отменена — неверный ABI даёт неработающее приложение.`);
    }
    chosen.push(hit.name);
    notes.push(`ABI: ${hit.value} (устройство: ${(props.abilist || []).join(', ')})`);
  }

  // ── Плотность: промах не фатален, ресурс возьмётся из базы ──
  const densItems = items.filter(i => i.kind === 'density');
  if (densItems.length) {
    const target = Number(opts.density || props.density) || null;
    if (!target) {
      notes.push('плотность устройства не определена — сплит плотности пропущен (ресурсы возьмутся из базового APK)');
    } else {
      let best = null, bestDelta = Infinity;
      for (const i of densItems) {
        const d = Math.abs(DENSITY_BUCKETS[i.value] - target);
        if (d < bestDelta) { best = i; bestDelta = d; }
      }
      chosen.push(best.name);
      notes.push(bestDelta === 0
        ? `плотность: ${best.value} (${target} dpi, точное совпадение)`
        : `плотность: ${best.value} — точной корзины под ${target} dpi в бандле нет, взята ближайшая (промах по плотности не фатален)`);
    }
  }
  for (const i of items.filter(i => i.kind === 'density_any')) chosen.push(i.name);

  // ── Локали: язык устройства + всё, что запрошено явно ──
  const locItems = items.filter(i => i.kind === 'locale');
  if (locItems.length) {
    const wanted = new Set();
    const devLang = String(props.locale || '').split('-')[0].toLowerCase();
    if (devLang) wanted.add(devLang);
    for (const l of coerceArray(opts.locales || [])) {
      const s = String(l || '').split(/[-_]/)[0].toLowerCase();
      if (s) wanted.add(s);
    }
    const picked = locItems.filter(i => wanted.has(String(i.value).split(/[-_]/)[0].toLowerCase()));
    chosen.push(...picked.map(i => i.name));
    if (picked.length)
      notes.push(`локали: ${picked.map(i => i.value).join(', ')} (язык устройства: ${devLang || '?'})`);
    else
      notes.push(`локали: подходящего сплита нет (язык устройства: ${devLang || '?'}; в бандле: ${locItems.map(i => i.value).join(', ')}) — строки возьмутся из базового APK`);
  }

  const unknown = items.filter(i => i.kind === 'unknown');
  if (unknown.length)
    notes.push(`не распознаны и пропущены: ${unknown.map(i => i.value).join(', ')}`);

  return { chosen: Array.from(new Set(chosen)), notes, items };
}

/** Распаковать бандл во временный каталог и выбрать сплиты. */
function unpackBundle(bundlePath, props, opts) {
  const buf = fs.readFileSync(bundlePath);
  const entries = zipEntries(buf).filter(e => /\.apk$/i.test(e.name) && !e.name.endsWith('/'));
  if (!entries.length) throw new Error('в бандле нет ни одного .apk');

  // standalones/ — сборки под старые устройства без поддержки сплитов;
  // при наличии обычных splits/ они только мешают выбору.
  const hasSplitsDir = entries.some(e => /(^|\/)splits\//i.test(e.name));
  const usable = hasSplitsDir
    ? entries.filter(e => !/(^|\/)standalones\//i.test(e.name))
    : entries;

  const sel = chooseSplits(usable.map(e => e.name), props, opts);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apks-'));
  const files = [];
  for (const name of sel.chosen) {
    const e = usable.find(x => x.name === name);
    const out = path.join(dir, name.split('/').pop());
    fs.writeFileSync(out, zipRead(buf, e));
    files.push(out);
  }
  return { dir, files, notes: sel.notes, total: usable.length };
}

async function install(args) {
  const rawPaths = coerceArray(args.apk_path).filter(p => typeof p === 'string' && p.trim() !== '');
  if (rawPaths.length === 0) throw new Error('apk_path is empty');

  // ── Бандл `.apks` ──
  if (rawPaths.length === 1 && BUNDLE_EXT.test(rawPaths[0])) {
    const bundle = resolveSafeHostPath(rawPaths[0]);
    if (!fs.existsSync(bundle)) throw new Error(`Bundle not found: ${bundle}`);

    const props = await getProps(args.serial);
    let tmp = null;
    try {
      tmp = unpackBundle(bundle, props, { abi: args.abi, density: args.density, locales: args.locales });

      const head =
        `Бандл: ${path.basename(bundle)} (${tmp.total} apk внутри)\n` +
        `Устройство: SDK ${props.sdk}, ABI ${(props.abilist || []).join(',') || '?'}, ` +
        `${props.density || '?'} dpi, локаль ${props.locale || '?'}\n` +
        `Выбрано ${tmp.files.length}: ${tmp.files.map(f => path.basename(f)).join(', ')}\n` +
        tmp.notes.map(n => `  · ${n}`).join('\n');

      if (args.dry_run === true || args.dry_run === 'true')
        return text(`${head}\n\ndry_run — ничего не установлено. Повтори с dry_run=false.`);

      const verb = tmp.files.length > 1 ? 'install-multiple' : 'install';
      const out = await adb(withSerial(args.serial, [verb, '-r', '-t', '-g', ...tmp.files]), { timeout: 300000 });
      return text(`${head}\n\n${verb}: ${out.trim() || 'OK'}`);
    } finally {
      if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  }

  // ── Обычные APK / готовый список сплитов ──
  const apks = rawPaths.map(p => {
    const r = resolveSafeHostPath(p);
    if (!fs.existsSync(r)) throw new Error(`APK not found: ${r}`);
    return r;
  });
  const verb = apks.length > 1 ? 'install-multiple' : 'install';
  const out = await adb(withSerial(args.serial, [verb, '-r', '-t', '-g', ...apks]), { timeout: 180000 });
  return text(out.trim() || `${verb}: ${apks.length} file(s) OK`);
}

async function uninstall(args) {
  const a = ['uninstall'];
  if (args.keep_data === true || args.keep_data === 'true') a.push('-k');
  a.push(args.package);
  const out = await adb(withSerial(args.serial, a), { timeout: 60000 });
  return text(out.trim());
}

async function push(args) {
  const src = resolveSafeHostPath(args.host_path);
  if (!fs.existsSync(src)) throw new Error(`File not found: ${src}`);
  const size = fs.statSync(src).size;
  // adb push пишет статистику в stderr, когда stdout не TTY — забираем оба
  const r = await adb(withSerial(args.serial, ['push', src, args.device_path]), { timeout: 120000, withStderr: true });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  return text(out || `Pushed ${src} -> ${args.device_path} (${size} bytes)`);
}

async function pull(args) {
  const dst = resolveSafeHostPath(args.host_path);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await adb(withSerial(args.serial, ['pull', args.device_path, dst]), { timeout: 120000, withStderr: true });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  let size = 0;
  try { const st = fs.statSync(dst); size = st.isFile() ? st.size : 0; } catch { /* ignore */ }
  return text(out || `Pulled ${args.device_path} -> ${dst}${size ? ` (${size} bytes)` : ''}`);
}

module.exports = {
  install, uninstall, push, pull,
  zipEntries, zipRead, qualifierOf, classify, chooseSplits,
};
