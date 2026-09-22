'use strict';
/**
 * apps.js — инструмент `adb_app`: операции над пакетами.
 *
 * Дизайн продиктован разбором инцидента Fire TV 2026-07-21/25 (см.
 * wiki/ha/devices/fire_tv.md и diagnostics_2026-08-07):
 *
 *  1. dry_run: true ПО УМОЛЧАНИЮ для всего, что меняет состояние.
 *  2. protected-набор ВЫВОДИТСЯ с устройства (device.js) и является ОТКАЗОМ
 *     в коде, а не предупреждением в описании. Пересечение => не выполняется
 *     НИЧЕГО, целиком: частичное применение хуже отказа.
 *  3. Канарейка по аккаунтам после КАЖДОЙ пачки. Потеря регистрации
 *     устройства — латентный отказ: система грузится, приложения работают,
 *     а вскрывается всё только в магазине. Именно на этом провалилась
 *     проверка 21.07 (смотрели ребут и память).
 *  4. Снапшот сделанного в /media => откат одним вызовом. `disable-user`
 *     обратим сам по себе, но 25.07 откатывать было НЕ ПО ЧЕМУ списку.
 *  5. `uninstall --user 0` доступен, но за тремя замками: опция аддона
 *     allow_uninstall, явный mode в вызове и успешный бэкап APK.
 *     Для СИСТЕМНЫХ пакетов он обратим (`cmd package install-existing`,
 *     проверено на Fire OS 7); необратимо только удаление сайдлоуда, чей
 *     APK больше нигде не лежит — отсюда обязательный бэкап.
 *  6. (1.2.5) Сетевой гард на разрушающих действиях: пакет, который ПРЯМО
 *     СЕЙЧАС обслуживает клиента вне устройства (LISTEN + входящее
 *     ESTABLISHED с не-loopback адреса), не отключается, не удаляется, не
 *     останавливается и не чистится без явного `force_network`. Признак
 *     снимается с устройства и потому работает на ЧУЖОМ железе, где канал
 *     интеграции держит другой пакет — список имён в коде защитил бы только
 *     ту квартиру, в которой его составили.
 *
 *     ⚠ У гарда СВОЙ флаг, отдельный от `force`. Первая редакция вешала оба
 *     на `force`, и это было ошибкой: `force` существует, чтобы продолжить
 *     при упавшем бэкапе APK, то есть его выставляют, думая про бэкап, — и
 *     заодно молча сняли бы защиту от обрыва живой службы. Один флаг на два
 *     несвязанных риска превращает осознанное решение в побочный эффект.
 */

const fs = require('fs');
const path = require('path');
const {
  adb, adbSh, withSerial, sq, text, json,
  coerceArray, coerceBool, coerceObject, resolveSafeHostPath, ensureDir, sanitizeSerial,
} = require('./adb.js');
const {
  getProps, listPackages, accountSnapshot, protectedSet,
  netListeners, servingHits, servingRefusal, resumedActivity,
} = require('./device.js');

const ALLOW_UNINSTALL = process.env.ALLOW_UNINSTALL === 'true';
// 1.3.0 (§4 спеки): нужен для отказа на CALL/CALL_PRIVILEGED/CALL_EMERGENCY
// при выключенном shell. Дублирует вычисление из session.js/server.js — тот
// же приём, что уже используется для ALLOW_UNINSTALL в этом файле.
const ALLOW_SHELL = process.env.ALLOW_SHELL !== 'false';
const DEFAULT_STORE = '/media/adb-mcp';
const DEFAULT_BATCH = 5;

// ---------------------------------------------------------------- хранилище

function storeRoot(args) {
  return resolveSafeHostPath(args.store || DEFAULT_STORE);
}

function deviceDir(args, serial) {
  return path.join(storeRoot(args), sanitizeSerial(serial));
}

function statePath(args, serial) {
  return path.join(deviceDir(args, serial), 'state.json');
}

function readState(args, serial) {
  const p = statePath(args, serial);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { device: sanitizeSerial(serial), updated: null, entries: [] };
  }
}

function writeState(args, serial, state) {
  const p = statePath(args, serial);
  ensureDir(path.dirname(p));
  state.updated = new Date().toISOString();
  // Пишем через временный файл: обрыв посреди записи не должен оставить
  // битый JSON — это единственный источник для отката.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

// ------------------------------------------------------------------ утилиты

/**
 * Версия и ABI пакета.
 *
 * ⚠ 1.1.1: было `grep -m2`. В выводе `dumpsys package` первыми идут
 * `primaryCpuAbi=` и `versionCode=`, так что лимит в две строки срезал
 * `versionName=` ДО того, как он встретится — поле было пустым везде:
 * в action=info, в выводе backup и в manifest.json (т.е. в единственном
 * документе, по которому восстанавливается удалённое приложение).
 * versionCode берётся первый — у `dumpsys` есть второй блок
 * "Hidden system packages" со СТАРОЙ версией для обновлённых
 * системных пакетов, и брать оттуда нельзя.
 */
async function packageVersion(serial, pkg) {
  const out = await adbSh(serial,
    `dumpsys package ${sq(pkg)} 2>/dev/null | grep -E "versionCode=|versionName=|primaryCpuAbi=" | head -n 20`);
  const code = (out.match(/versionCode=(\d+)/) || [])[1] || '0';
  const abi = (out.match(/primaryCpuAbi=(\S+)/) || [])[1] || '';
  // versionName занимает строку целиком и может содержать пробелы
  // ("1.0 beta"), но на части прошивок рядом дописаны другие поля.
  let name = ((out.match(/versionName=(.*)/) || [])[1] || '').trim();
  if (/\s[A-Za-z_]\w*=/.test(name)) name = name.split(/\s+/)[0];
  return { versionCode: code, versionName: name, primaryCpuAbi: abi };
}

async function packagePaths(serial, pkg) {
  const out = await adbSh(serial, `pm path ${sq(pkg)} 2>/dev/null`);
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('package:'))
    .map(l => l.slice('package:'.length).trim())
    .filter(Boolean);
}

/**
 * Вытянуть все APK пакета в хранилище. Возвращает каталог с манифестом.
 * Для системных пакетов это тоже работает, но ставить их обратно как
 * пользовательские обычно нельзя (подпись платформы / shared uid) — для них
 * путь отката другой: pm enable либо cmd package install-existing.
 */
async function backupPackage(serial, pkg, args, props) {
  const remote = await packagePaths(serial, pkg);
  if (!remote.length) throw new Error(`pm path returned nothing for ${pkg} - package not installed?`);
  const ver = await packageVersion(serial, pkg);
  const dir = path.join(deviceDir(args, serial), 'apk', pkg, ver.versionCode || '0');
  ensureDir(dir);

  const files = [];
  for (const r of remote) {
    const base = path.basename(r);
    const local = path.join(dir, base);
    await adb(withSerial(serial, ['pull', r, local]), { timeout: 180000 });
    const size = fs.existsSync(local) ? fs.statSync(local).size : 0;
    if (!size) throw new Error(`Backup ${pkg}: file ${base} pulled empty`);
    files.push({ name: base, size, device_path: r });
  }

  const manifest = {
    package: pkg,
    versionName: ver.versionName,
    versionCode: ver.versionCode,
    primaryCpuAbi: ver.primaryCpuAbi,
    splits: files.map(f => f.name),
    files,
    device: { serial, model: props.model, sdk: props.sdk, density: props.density, locale: props.locale, abilist: props.abilist },
    pulled_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifest };
}

async function installFromBackupDir(serial, dir) {
  const apks = fs.readdirSync(dir).filter(f => f.endsWith('.apk')).map(f => path.join(dir, f));
  if (!apks.length) throw new Error(`No .apk in ${dir}`);
  const verb = apks.length > 1 ? 'install-multiple' : 'install';
  const out = await adb(withSerial(serial, [verb, '-r', '-t', '-g', ...apks]), { timeout: 180000 });
  return out.toString().trim() || `${verb}: ${apks.length} file(s) OK`;
}

// ------------------------------------------------------------- канарейка

/**
 * Проверка «система ещё цела» между пачками.
 * Сравнивается с базовой линией, снятой ДО первой пачки.
 */
async function canaryCheck(serial, baseline) {
  const result = { ok: true, problems: [] };

  const acc = await accountSnapshot(serial);
  result.accounts = acc;
  if (baseline.accounts.available && acc.available && acc.count < baseline.accounts.count) {
    result.ok = false;
    result.problems.push(
      `account count went from ${baseline.accounts.count} to ${acc.count} - device registration lost`);
  }

  try {
    const home = await adbSh(serial,
      'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1');
    result.launcher = home.trim();
    if (!result.launcher || /no activity|null/i.test(result.launcher)) {
      result.ok = false;
      result.problems.push('the launcher no longer resolves - the device would be left without a home screen');
    }
  } catch (e) {
    result.ok = false;
    result.problems.push(`launcher could not be checked: ${e.message}`);
  }

  return result;
}

// ------------------------------------------------------------ сетевой гард

/**
 * Отказать, если хоть один из пакетов ПРЯМО СЕЙЧАС обслуживает клиента вне
 * устройства. Признак и его разбор живут в device.js — здесь только решение.
 *
 * Почему это отдельный ярус, а не строчка в protected-наборе. Protected-набор
 * отвечает на вопрос «можно ли этот пакет потерять» и потому применим лишь к
 * disable/uninstall. Гард отвечает на другой — «прервётся ли прямо сейчас
 * чья-то живая работа», и он применим ещё и к force-stop с clear, у которых
 * защиты не было вовсе.
 *
 * Порядок важен: гард проверяется РАНЬШЕ protected-набора. Отказ гарда
 * называет порт и удалённый адрес, то есть говорит, что именно сломается,
 * а отказ protected-набора — только что пакет в списке. При этом `force_network`
 * снимает ТОЛЬКО гард: системный пакет после него упрётся в protected-набор,
 * у которого обхода нет и не будет. `force` (провал бэкапа APK) гард НЕ
 * снимает — это разные риски и разные решения.
 *
 * Если сам признак не снялся (шелл не смог прочитать /proc/net) — это не
 * повод молча продолжить и не повод запретить всё: гард сообщает, что он
 * слеп, и вызывающий видит это в выдаче. Молчание здесь было бы ровно тем,
 * от чего защищается весь модуль.
 */
async function networkGuard(serial, packages, what, forceNetwork, netSnapshot) {
  let net = netSnapshot;
  if (!net) {
    try {
      net = await netListeners(serial);
    } catch (e) {
      net = { ok: false, byPackage: {}, byUid: {}, unattributed: [],
        note: `network signal not collected (${e.message}) - the guard did NOT run` };
    }
  }

  const hits = servingHits(net, packages);
  if (hits.length && !forceNetwork) throw new Error(servingRefusal(hits, what));

  return {
    hits,
    overridden: hits,          // непусто только при force_network: иначе был бы throw
    blind: net.ok === false,
    note: net.note || null,
    net,
  };
}

/** Как гард выглядит в JSON-выдаче. Слепой гард обязан быть виден. */
function guardReport(guard) {
  if (guard.blind)
    return { status: 'blind', note: guard.note, checked: false,
      why: 'the signal could not be read from the device - the destructive action runs without the network check' };
  if (guard.overridden.length)
    return { status: 'overridden', checked: true, overridden: guard.overridden, note: guard.note,
      why: 'the network guard was lifted by force_network=true' };
  return { status: 'not_serving', checked: true, note: guard.note };
}

// ------------------------------------------------------------------ действия

async function actList(serial, args) {
  const pkgs = await listPackages(serial);
  const filter = String(args.filter || 'user').toLowerCase();
  const q = args.q ? String(args.q).toLowerCase() : null;

  let list;
  if (filter === 'all') list = pkgs.all;
  else if (filter === 'system') list = pkgs.all.filter(p => pkgs.system.has(p));
  else if (filter === 'disabled') list = pkgs.all.filter(p => pkgs.disabled.has(p));
  else list = pkgs.all.filter(p => !pkgs.system.has(p));

  if (q) list = list.filter(p => p.toLowerCase().includes(q));
  list = list.sort();

  const lines = list.map(p => {
    const flags = [pkgs.system.has(p) ? 'system' : 'user'];
    if (pkgs.disabled.has(p)) flags.push('DISABLED');
    return `${p} [${flags.join(',')}]`;
  });
  return text(
    `filter=${filter}${q ? ` q=${q}` : ''} - ${list.length} of ${pkgs.all.length} packages\n\n` +
    (lines.join('\n') || '(none)'));
}

async function actInfo(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error('action=info requires packages');
  const pkgs = await listPackages(serial);
  const out = [];
  for (const p of packages) {
    if (!pkgs.all.includes(p)) { out.push({ package: p, installed: false }); continue; }
    const ver = await packageVersion(serial, p);
    out.push({
      package: p,
      installed: true,
      system: pkgs.system.has(p),
      disabled: pkgs.disabled.has(p),
      ...ver,
      paths: await packagePaths(serial, p),
    });
  }
  return json(out);
}

// Токен am/intent: то же ограничение, что уже используется для extras-ключей
// и для action — никаких произвольных флагов `am` снаружи вызова.
const AM_TOKEN_RE = /^[A-Za-z0-9_.]+$/;

// §4 спеки, ревизия 17.09: выключенный shell не должен молча вернуть
// способность звонить через intent-запуск. Так ли это реально сработает —
// источники расходятся (есть примеры и успеха, и SecurityException), но
// проверка = настоящий звонок, поэтому НЕ проверяется на железе; отказ стоит
// независимо от ответа на этот вопрос физики. При allow_shell=true отказа
// нет — adb_shell и так умеет звонить.
const CALL_ACTIONS = new Set([
  'android.intent.action.CALL',
  'android.intent.action.CALL_PRIVILEGED',
  'android.intent.action.CALL_EMERGENCY',
]);

/**
 * extras → флаги `am start`: string → --es, boolean → --ez, целое в int32 →
 * --ei, более крупное целое → --el, всё прочее — отказ с именем ключа.
 * Принимает и JSON-строку объекта: клиент claude.ai сериализует объекты
 * так же, как массивы (урок 0.5.1, coerceArray) — отсюда coerceObject.
 */
function extrasToAmFlags(extras) {
  const obj = coerceObject(extras);
  const flags = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!AM_TOKEN_RE.test(k)) throw new Error(`extras.${k}: key name must match [A-Za-z0-9_.]+`);
    if (typeof v === 'boolean') flags.push('--ez', sq(k), sq(String(v)));
    else if (typeof v === 'string') flags.push('--es', sq(k), sq(v));
    else if (typeof v === 'number' && Number.isInteger(v)) {
      const isInt32 = v >= -2147483648 && v <= 2147483647;
      flags.push(isInt32 ? '--ei' : '--el', sq(k), sq(String(v)));
    } else {
      throw new Error(`extras.${k}: unsupported value type (${typeof v}) - allowed: string, boolean, integer`);
    }
  }
  return flags;
}

/**
 * Разбор вывода `am start -W` для intent-запуска (§4 спеки, ревизия 17.09).
 *
 * ⚠ Формат `-W` различается между SDK 28 и 36 (LaunchState/WaitTime/
 * TotalTime появляются и пропадают) — разбираем ТЕРПИМО, по префиксу
 * строки, а не одной регуляркой по всему выводу. `/Error|Exception/i` по
 * всему тексту (как было в 1.2.4 для старого пути) ложно сработала бы на
 * URI со словом error в эхо-строке `Starting: Intent { ... dat=... }`, а
 * «Warning: ... has been delivered to currently running top-most instance»
 * содержит «Activity not started», что похоже на отказ, а на деле успех.
 * Эхо-строку `Starting: Intent { ... }` НЕ анализируем вовсе — в ней URI и
 * extras как есть, включая любые слова пользователя.
 */
async function parseAmStartOutput(serial, out, ctx) {
  const lines = String(out || '').split('\n').map(l => l.trim()).filter(Boolean);
  const nonEcho = lines.filter(l => !/^Starting:\s*Intent\s*\{/.test(l));
  const rawOut = String(out || '').trim();

  // 1. Нет обработчика.
  if (nonEcho.some(l => /^Error:\s*Activity not started, unable to resolve Intent/.test(l)))
    throw new Error(`No handler for this intent (action=${ctx.action}).\n${rawOut}`);

  // 2. «Доставлено в уже открытое» — успех, и проверяется ДО общих ошибок:
  //    в строке есть «Activity not started», по виду похожее на отказ.
  const delivered = nonEcho.find(l =>
    /^Warning:\s*Activity not started, intent has been delivered to currently running top-most instance/.test(l));
  if (delivered)
    return text(`Delivered to the already running instance (${ctx.pkg || ctx.action}).\n${delivered}`);

  // 3. Диалог выбора обработчика — тул сам его открыл, сам и убирает: один
  //    KEYCODE_BACK, перечитать resumed. Если диалог всё ещё наверху —
  //    сообщить как есть, больше клавиш не слать (§9: не повторять и не
  //    слать больше одного BACK).
  const activityLine = nonEcho.find(l => /^Activity:\s*/.test(l));
  if (activityLine && /ResolverActivity|ChooserActivity/.test(activityLine)) {
    await adb(withSerial(serial, ['shell', 'input keyevent KEYCODE_BACK']));
    await new Promise(r => setTimeout(r, 500));
    const after = await resumedActivity(serial);
    if (after.raw && /ResolverActivity|ChooserActivity/.test(after.raw))
      return text(`Several handlers; the chooser dialog is still on top: ${after.raw}`);
    return text(`Several handlers; the chooser dialog was closed - pass packages.\n${activityLine}`);
  }

  // 4. Прочие ошибки — по началу строки (Error:) или по регистрозависимому
  //    вхождению «Exception», НЕ /error/i по всему выводу целиком. Именно
  //    подстрока, а не \bException\b: `java.lang.SecurityException` — это
  //    ОДНО слово-идентификатор, границы перед «Exception» в нём нет, и
  //    \b-вариант эту строку молча пропускал бы (найдено при тестировании
  //    без устройства — упало в п.5 и дёргало adb вместо честного отказа).
  //
  //    Подстрока «Exception» ищется НЕ по всем строкам, а только по тем, что
  //    не начинаются с `Starting:` или `Activity:` — имя компонента вида
  //    `pkg/.ExceptionHandlerActivity` попадает и в эхо-строку intent'а, и в
  //    строку `Activity: pkg/.ExceptionHandlerActivity` из п.3, и это имя
  //    активности, а не диагностика am. `Starting:` здесь избыточно поверх
  //    nonEcho (тот уже вырезает `Starting: Intent {`), но перестраховка не
  //    мешает, если формат эха когда-нибудь слегка изменится.
  const errPool = nonEcho.filter(l => !/^Starting:/.test(l) && !/^Activity:/.test(l));
  const errLine = errPool.find(l => /^Error:/.test(l) || l.includes('Exception'));
  if (errLine) throw new Error(`am start refused: ${errLine}\n${rawOut}`);

  // 5. Status: ok или строки Status нет вовсе — подтверждаем по resumed, как в 1.2.4.
  await new Promise(r => setTimeout(r, 1200));
  const after = await resumedActivity(serial);
  const okByResumed = ctx.pkg ? !!(after.raw && after.raw.includes(ctx.pkg)) : !!after.component;

  const head = `intent (action=${ctx.action}${ctx.pkg ? `, -p ${ctx.pkg}` : ''})`;
  if (okByResumed)
    return text(`Launched via ${head}.\n${rawOut ? rawOut + '\n' : ''}Confirmed in the foreground: ${after.raw}`);

  return text(
    `⚠ ${head} was sent without error, but the package is not in the foreground.\n` +
    `On top now: ${after.raw || '(not determined - neither ResumedActivity nor mCurrentFocus)'}\n${rawOut}`);
}

/**
 * Intent/deep-link запуск (§4 спеки, 1.3.0) — параллельный путь к обычному
 * запуску пакета по имени, включается наличием uri или intent_action.
 * packages здесь необязателен: с одним значением уходит в `-p`, что сужает
 * обработчик и убирает диалог выбора; больше одного — отказ (packages это
 * не список получателей, а сужение резолвера).
 */
async function actLaunchIntent(serial, args, packages) {
  if (packages.length > 1)
    throw new Error(`action=launch with uri/intent_action accepts at most one package (used as -p), got: ${packages.join(', ')}`);
  const pkg = packages[0] || null;

  const action = String(args.intent_action || 'android.intent.action.VIEW');
  if (!AM_TOKEN_RE.test(action))
    throw new Error(`intent_action \"${action}\" does not match [A-Za-z0-9_.]+`);

  if (CALL_ACTIONS.has(action) && !ALLOW_SHELL)
    throw new Error(
      `intent_action=${action} refused: the add-on option allow_shell is off. ` +
      `Turn allow_shell on and use adb_shell if this is intended.`);

  const extraFlags = extrasToAmFlags(args.extras);

  const parts = ['am', 'start', '-W', '-a', sq(action)];
  if (args.uri) parts.push('-d', sq(String(args.uri)));
  if (pkg) parts.push('-p', sq(pkg));
  parts.push(...extraFlags);
  const cmd = `${parts.join(' ')} 2>&1`;

  let out = '';
  try {
    out = await adbSh(serial, cmd, { timeout: 20000 });
  } catch (e) {
    // Таймаут `-W` — не провал запуска (спека §4): сообщаем и переходим к
    // сверке resumed вместо отказа. Другие сбои (устройство недоступно и
    // т.п.) пробрасываются — сверять resumed на мёртвом устройстве бессмысленно.
    if (!/timeout|killed/i.test(e.message)) throw e;
    out = 'am -W did not answer in time (call timeout) - checking what started against the resumed activity.';
  }

  return parseAmStartOutput(serial, out, { pkg, action });
}

async function actLaunch(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);

  // §4 спеки: intent/deep-link путь включается наличием uri ИЛИ intent_action.
  // Без обоих — старый путь ниже, без единого изменения поведения и текстов.
  if (args.uri || args.intent_action) return actLaunchIntent(serial, args, packages);

  const pkg = packages[0];
  if (!pkg) throw new Error('action=launch requires packages');
  // Запуск пакета по имени — задача неожиданно склочная, и 1.2.3 переписала
  // её после охоты по живым устройствам (Shield, Fire OS, Android 16).
  //
  // Что выяснилось:
  //  · monkey с категорией LAUNCHER молча отказывает — rc != 0, ноль
  //    инжектов, иногда лишь строка про SYS_KEYS. Признак настоящего
  //    запуска один: «Events injected».
  //  · У ТВ-приложений MAIN объявлен с LEANBACK_LAUNCHER, а не LAUNCHER
  //    (com.android.tv.settings). Одной категории мало.
  //  · Бывает и без обеих: у com.nvidia.shield.welcome активность находится
  //    только запросом MAIN вообще без категории.
  //  · ⚠ И главная ловушка: `resolve-activity -a MAIN` для tv.settings
  //    отдаёт `android/com.android.internal.app.ResolverActivity` — системный
  //    диалог выбора, а не приложение. Формату «пакет/активность» он
  //    соответствует, поэтому проверять надо ПРИНАДЛЕЖНОСТЬ активности
  //    запрошенному пакету, иначе тул запустит не то и отчитается об успехе.
  const CATS = ['android.intent.category.LAUNCHER', 'android.intent.category.LEANBACK_LAUNCHER'];
  const tried = [];

  for (const cat of CATS) {
    const out = await adbSh(serial, `monkey -p ${sq(pkg)} -c ${cat} 1 2>&1 | tail -n 3`);
    if (/Events injected:\s*[1-9]/.test(out))
      return text(`Launched ${pkg} (monkey, ${cat.split('.').pop()})\n${out.trim()}`);
    tried.push(`monkey ${cat.split('.').pop()}: no events injected`);
  }

  // Фолбэк: спросить у системы имя главной активности и стартовать явно.
  let act = '';
  for (const q of [`-a android.intent.action.MAIN -c ${CATS[0]}`,
                   `-a android.intent.action.MAIN -c ${CATS[1]}`,
                   '-a android.intent.action.MAIN']) {
    const r = (await adbSh(serial,
      `cmd package resolve-activity --brief ${q} ${sq(pkg)} 2>/dev/null | tail -n 1`)).trim();
    if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(r)) { tried.push(`resolve ${q}: ${r || 'empty'}`); continue; }
    if (r.split('/')[0] !== pkg) {
      // ResolverActivity и прочие чужие активности — не наш пакет.
      tried.push(`resolve ${q}: ${r} - activity of another package, discarded`);
      continue;
    }
    act = r;
    break;
  }

  if (!act)
    throw new Error(
      `Cannot launch ${pkg}: the main activity does not resolve.\n` +
      tried.map(t => `  · ${t}`).join('\n') +
      `\nTry \`adb_shell cmd package query-activities -a android.intent.action.MAIN\`; ` +
      `the package may have no launchable activity at all (service, provider, overlay).`);

  const started = await adbSh(serial, `am start -n ${sq(act)} 2>&1`);
  if (/Error|Exception/i.test(started))
    throw new Error(`Cannot launch ${pkg} via ${act}: ${started.trim()}`);

  // Не верим на слово ни monkey, ни am — сверяем, что поднялось на самом деле.
  //
  // ⚠ 1.2.4: раньше сверка шла по `mCurrentFocus`, и это плохой свидетель.
  // На Shield он равен `null` даже когда лаунчер жив и активен, так что
  // предупреждение срабатывало там, где сверять было попросту нечем.
  // Настоящий ответ даёт резюмированная активность; `mCurrentFocus`
  // оставлен вторым мнением для прошивок, где первого нет.
  //
  // 1.3.0: сама сверка вынесена в device.resumedActivity() — ею же
  // пользуется intent-путь launch и verify у adb_tap/adb_swipe/adb_key
  // (§4/§5 спеки). Рефакторинг: тексты и поведение этой ветки не меняются.
  await new Promise(r => setTimeout(r, 1200));
  const { raw: seen, resumedLine: resumed, focusLine: focus } = await resumedActivity(serial);

  if (resumed.includes(pkg) || focus.includes(pkg))
    return text(
      `Launched ${pkg} via ${act} (monkey did not inject: ${tried[0]}).\n` +
      `Package confirmed in the foreground.`);

  // Активность стартовала без ошибки, но наверху её нет. Чаще всего это
  // не гонка, а самозакрытие: мастера первичной настройки и подобные
  // экраны проверяют своё условие и сразу finish() — так ведёт себя
  // com.nvidia.shield.welcome на Shield. Гадать не будем, покажем факты.
  return text(
    `⚠ ${pkg}: activity ${act} started without error, but it is not in the foreground.\n` +
    `On top now: ${seen || '(not determined - neither ResumedActivity nor mCurrentFocus)'}\n` +
    `The usual cause is that the activity closed itself (setup wizard, placeholder screen); ` +
    `less often it needed more time. Take adb_screenshot if this matters.`);
}

async function actStopOrClear(serial, args, action) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error(`action=${action} requires packages`);
  const dryRun = coerceBool(args.dry_run, action === 'clear');  // clear стирает данные — по умолчанию dry_run
  const forceNetwork = coerceBool(args.force_network, false);

  // Сетевой гард (1.2.5). До него у stop и clear не было НИКАКОЙ защиты:
  // protected-набор проверяется только в disable/uninstall, а `am force-stop`
  // на пакете, который держит канал интеграции, отключает её ровно так же —
  // просто до следующего запуска сервиса, а не насовсем. `pm clear` хуже:
  // он и останавливает, и стирает данные, то есть на службе пульта унесёт
  // сопряжение. Поэтому гард стоит на обоих, хотя в ТЗ назван force-stop.
  //
  // ⚠ Штатное умолчание `stop` — dry_run=false, то есть один вызов без
  // единого параметра сразу что-то останавливал. Это и есть та дыра.
  const guard = await networkGuard(serial, packages, action === 'stop' ? 'force-stop' : 'clear', forceNetwork);

  if (dryRun) {
    return text(`dry_run: ${action} for ${packages.length} package${packages.length === 1 ? '' : 's'}:\n` +
      packages.map(p => `  ${p}`).join('\n') +
      (guard.overridden.length
        ? `\n\n⚠ force_network=true overrides the network guard for: ` +
          guard.overridden.map(h => `${h.package} (${h.serving.join(', ')})`).join('; ')
        : '') +
      (guard.blind ? `\n\n⚠ ${guard.note}` : '') +
      `\n\nRepeat with dry_run=false to apply.`);
  }

  const done = [];
  if (guard.overridden.length)
    done.push(`⚠ force_network=true: the network guard is overridden for ` +
      guard.overridden.map(h => `${h.package} (${h.serving.join(', ')})`).join('; '));
  if (guard.blind) done.push(`⚠ ${guard.note}`);

  for (const p of packages) {
    const cmd = action === 'stop' ? `am force-stop ${sq(p)}` : `pm clear ${sq(p)}`;
    const out = await adbSh(serial, `${cmd} 2>&1`);
    done.push(`${p}: ${out.trim() || 'ok'}`);
  }
  return text(done.join('\n'));
}

/**
 * disable / uninstall — единственное по-настоящему опасное действие.
 */
async function actRemove(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error('action requires packages');

  const mode = String(args.mode || 'disable').toLowerCase();
  if (!['disable', 'uninstall'].includes(mode))
    throw new Error(`mode must be disable or uninstall, got: ${mode}`);
  if (mode === 'uninstall' && !ALLOW_UNINSTALL)
    throw new Error(
      'mode=uninstall is forbidden by the add-on configuration (allow_uninstall: false). ' +
      'Turn the option on in the add-on settings and restart it if removal is really needed ' +
      'rather than reversible disabling (mode=disable).');

  const dryRun = coerceBool(args.dry_run, true);
  const doCanary = coerceBool(args.canary, true);
  const doBackup = coerceBool(args.backup, mode === 'uninstall');
  const force = coerceBool(args.force, false);               // только про провал бэкапа APK
  const forceNetwork = coerceBool(args.force_network, false); // только про сетевой гард
  const batchSize = Math.max(1, Math.min(parseInt(args.batch_size, 10) || DEFAULT_BATCH, 25));

  const props = await getProps(serial);
  const pkgs = await listPackages(serial);
  const prot = await protectedSet(serial, { props, packages: pkgs });

  const unknown = packages.filter(p => !pkgs.all.includes(p));
  if (unknown.length)
    throw new Error(`Not installed on the device: ${unknown.join(', ')}`);

  // Сетевой гард — ДО protected-набора: его отказ называет порт и живого
  // клиента, а не просто факт членства в списке. Снимок /proc/net берётся
  // из protectedSet, второго чтения устройства не происходит.
  const guard = await networkGuard(serial, packages, mode, forceNetwork, prot.net);

  const hit = packages.filter(p => prot.packages.includes(p));
  if (hit.length)
    throw new Error(
      `REFUSED: the list contains protected packages - ${hit.join(', ')}.\n` +
      `Protection sources: ${JSON.stringify(prot.sources)}\n` +
      `Nothing was applied. Remove them from the list by hand; the tool has no override.`);

  // Предупреждения по ПОЛЬЗОВАТЕЛЬСКИМ пакетам с признаками внешней
  // связности (слушающий сокет / аутентификатор аккаунта). Это НЕ
  // отказ — такой пакет обратим через бэкап APK. Но молчать о нём
  // тоже нельзя: весь смысл признака в том, что последствие видно
  // только снаружи устройства, а значит и канарейка его не поймает.
  const advisories = (prot.advisories || []).filter(a => packages.includes(a.package));

  const plan = packages.map(p => ({
    package: p,
    system: pkgs.system.has(p),
    already_disabled: pkgs.disabled.has(p),
    action: mode,
    warnings: advisories.filter(a => a.package === p).map(a => `${a.signal}: ${a.detail}`),
    backup: doBackup && !pkgs.system.has(p) ? 'yes (user package)'
      : doBackup ? 'yes (system package - the APK is saved, but it is restored via install-existing)' : 'no',
    rollback: mode === 'disable' ? 'pm enable'
      : pkgs.system.has(p) ? 'cmd package install-existing' : 'install from the APK backup',
  }));

  const baseline = { accounts: await accountSnapshot(serial) };

  if (dryRun) {
    return json({
      dry_run: true,
      mode,
      batch_size: batchSize,
      canary: doCanary,
      store: deviceDir(args, serial),
      baseline_accounts: baseline.accounts,
      protected_count: prot.packages.length,
      protected_sources: prot.sources,
      protected_notes: prot.notes,
      network_guard: guardReport(guard),
      advisories,
      plan,
      hint: advisories.length
        ? 'Advisories present - read them before continuing. Repeat with dry_run=false. Rollback: adb_app action=restore.'
        : 'Repeat with dry_run=false. Rollback: adb_app action=restore.',
    });
  }

  if (mode === 'uninstall' && !doBackup && !force)
    throw new Error('mode=uninstall with backup=false requires force=true - otherwise rollback is not possible for every package');

  const state = readState(args, serial);
  const report = { mode, applied: [], failed: [], stopped: false, canary: [] };
  report.network_guard = guardReport(guard);
  if (advisories.length) report.advisories = advisories;

  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    const batchApplied = [];

    for (const p of batch) {
      const isSystem = pkgs.system.has(p);
      let backupDir = null;
      try {
        if (doBackup) {
          try {
            backupDir = (await backupPackage(serial, p, args, props)).dir;
          } catch (e) {
            if (!force) throw new Error(`backup failed (${e.message}) - stopping; repeat with force=true if this is intended`);
            backupDir = null;
          }
        }
        const cmd = mode === 'disable'
          ? `pm disable-user --user 0 ${sq(p)} 2>&1`
          : `pm uninstall --user 0 ${sq(p)} 2>&1`;
        const out = await adbSh(serial, cmd);
        if (/Failure|Exception|Error:/i.test(out)) throw new Error(out.trim());

        const entry = {
          package: p, mode, system: isSystem, backup: backupDir,
          ts: new Date().toISOString(), result: out.trim(),
        };
        state.entries = state.entries.filter(e => e.package !== p);
        state.entries.push(entry);
        batchApplied.push(entry);
        report.applied.push(entry);
      } catch (e) {
        report.failed.push({ package: p, error: e.message });
      }
    }

    writeState(args, serial, state);

    if (doCanary) {
      const c = await canaryCheck(serial, baseline);
      report.canary.push({ after_batch: Math.floor(i / batchSize) + 1, ...c });
      if (!c.ok) {
        // Откатываем ТОЛЬКО эту пачку и останавливаемся.
        const rolledBack = [];
        for (const e of batchApplied) {
          try {
            await restoreEntry(serial, e, args);
            state.entries = state.entries.filter(x => x.package !== e.package);
            rolledBack.push(e.package);
          } catch (err) {
            report.failed.push({ package: e.package, error: `rollback failed: ${err.message}` });
          }
        }
        writeState(args, serial, state);
        report.stopped = true;
        report.rolled_back = rolledBack;
        report.reason = c.problems.join('; ');
        break;
      }
    }
  }

  report.state_file = statePath(args, serial);
  report.next = 'Check the device by eye: home screen, store, account sign-in. ' +
    'Check again after a reboot - some failures only show up on the next boot.';
  return json(report);
}

async function restoreEntry(serial, entry, args) {
  if (entry.mode === 'disable') {
    const out = await adbSh(serial, `pm enable ${sq(entry.package)} 2>&1`);
    if (/Error|Exception/i.test(out)) throw new Error(out.trim());
    return out.trim();
  }
  // uninstall
  if (entry.system) {
    const out = await adbSh(serial, `cmd package install-existing --user 0 ${sq(entry.package)} 2>&1`);
    if (/Error|Failure/i.test(out)) throw new Error(out.trim());
    return out.trim();
  }
  if (!entry.backup) throw new Error(`no APK backup for ${entry.package} - nothing to restore from`);
  return await installFromBackupDir(serial, entry.backup);
}

async function actEnableOrRestore(serial, args, action) {
  const state = readState(args, serial);
  const asked = coerceArray(args.packages || args.package).filter(Boolean);
  const dryRun = coerceBool(args.dry_run, true);

  let targets;
  if (action === 'enable' && asked.length) {
    // прямое включение, даже если пакета нет в снапшоте
    targets = asked.map(p => {
      const known = state.entries.find(e => e.package === p);
      return known || { package: p, mode: 'disable', system: true, backup: null };
    });
  } else {
    targets = asked.length ? state.entries.filter(e => asked.includes(e.package)) : state.entries.slice();
    if (asked.length) {
      const missing = asked.filter(p => !state.entries.some(e => e.package === p));
      if (missing.length) throw new Error(`Not in the snapshot: ${missing.join(', ')}. Use action=enable for a direct enable.`);
    }
  }

  if (!targets.length) return text('The snapshot is empty - nothing to restore.');

  if (dryRun) {
    return json({
      dry_run: true,
      state_file: statePath(args, serial),
      plan: targets.map(e => ({
        package: e.package,
        was: e.mode,
        how: e.mode === 'disable' ? 'pm enable'
          : e.system ? 'cmd package install-existing' : `install from ${e.backup || '(no backup)'}`,
      })),
      hint: 'Repeat with dry_run=false.',
    });
  }

  const done = [], failed = [];
  for (const e of targets) {
    try {
      const res = await restoreEntry(serial, e, args);
      state.entries = state.entries.filter(x => x.package !== e.package);
      done.push({ package: e.package, result: res });
    } catch (err) {
      failed.push({ package: e.package, error: err.message });
    }
  }
  writeState(args, serial, state);
  return json({ restored: done, failed, state_file: statePath(args, serial) });
}

async function actBackup(serial, args) {
  const pkgs = await listPackages(serial);
  let packages = coerceArray(args.packages || args.package).filter(Boolean);
  const scope = String(args.scope || (packages.length ? 'list' : 'user')).toLowerCase();

  if (!packages.length) {
    if (scope === 'user') packages = pkgs.all.filter(p => !pkgs.system.has(p));
    else if (scope === 'all') packages = pkgs.all.slice();
    else throw new Error('action=backup requires packages or scope=user|all');
  }

  const dryRun = coerceBool(args.dry_run, false);
  if (dryRun) {
    return text(`dry_run: ${packages.length} package${packages.length === 1 ? '' : 's'} will be saved to ` +
      `${path.join(deviceDir(args, serial), 'apk')}:\n` + packages.map(p => `  ${p}`).join('\n'));
  }

  const props = await getProps(serial);
  const saved = [], failed = [];
  for (const p of packages) {
    try {
      const r = await backupPackage(serial, p, args, props);
      saved.push({ package: p, dir: r.dir, splits: r.manifest.splits, version: r.manifest.versionName });
    } catch (e) {
      failed.push({ package: p, error: e.message });
    }
  }
  return json({ saved_count: saved.length, saved, failed, store: deviceDir(args, serial) });
}

async function actState(serial, args) {
  const state = readState(args, serial);
  const dir = deviceDir(args, serial);
  let backups = [];
  try {
    const apkRoot = path.join(dir, 'apk');
    backups = fs.readdirSync(apkRoot).map(pkg => {
      const versions = fs.readdirSync(path.join(apkRoot, pkg));
      return { package: pkg, versions };
    });
  } catch { /* каталога ещё нет */ }
  return json({ store: dir, state_file: statePath(args, serial), state, backups });
}

// -------------------------------------------------------------- точка входа

async function adbApp(args) {
  const serial = args.serial;
  const action = String(args.action || '').toLowerCase();

  switch (action) {
    case 'list':      return actList(serial, args);
    case 'info':      return actInfo(serial, args);
    case 'launch':    return actLaunch(serial, args);
    case 'stop':      return actStopOrClear(serial, args, 'stop');
    case 'clear':     return actStopOrClear(serial, args, 'clear');
    case 'disable':   return actRemove(serial, { ...args, mode: args.mode || 'disable' });
    case 'uninstall': return actRemove(serial, { ...args, mode: 'uninstall' });
    case 'enable':    return actEnableOrRestore(serial, args, 'enable');
    case 'restore':   return actEnableOrRestore(serial, args, 'restore');
    case 'backup':    return actBackup(serial, args);
    case 'state':     return actState(serial, args);
    case 'protected': {
      const props = await getProps(serial);
      // net — сырой снимок для гарда, в отчёт не идёт: то же самое уже
      // разложено по sources.net_listener и sources.net_unattributed.
      const { net, ...prot } = await protectedSet(serial, { props });
      void net;
      return json({ device: props, ...prot });
    }
    default:
      throw new Error(`Unknown action: ${action || '(empty)'}. ` +
        `Allowed: list, info, protected, launch, stop, clear, disable, uninstall, enable, restore, backup, state`);
  }
}

module.exports = {
  adbApp, ALLOW_UNINSTALL, DEFAULT_STORE,
  // 1.3.0: экспортируется для юнит-проверок без устройства (§4 спеки).
  parseAmStartOutput, extrasToAmFlags, CALL_ACTIONS, AM_TOKEN_RE,
};
