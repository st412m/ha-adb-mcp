'use strict';
/**
 * device.js — факты, снимаемые С САМОГО устройства.
 *
 * Главный принцип модуля: protected-набор ВЫВОДИТСЯ, а не ведётся списком в
 * коде. Причина конкретная — инцидент с Fire TV 2026-07-21/25: отключение по
 * публичному «безопасному списку» унесло com.amazon.tv.ottssocompanionapp
 * (OTT Single Sign-On), приставка разлогинилась из аккаунта Amazon, повторный
 * вход вешал систему наглухо, лечилось только заводским сбросом. Ни один
 * список по именам этот пакет бы не пометил — а запрос к устройству находит
 * его стек за один вызов.
 *
 * Ярусность обязательна: источники есть не на всех прошивках, поэтому каждый
 * опрашивается независимо. НО молчаливый пропуск — это отдельная опасность:
 * приёмка 1.1.0 (2026-08-07) показала, что провалившийся источник выглядел в
 * выдаче ровно как «источника тут нет», и дыра в защите была не видна.
 * Отсюда правило модуля: КАЖДЫЙ несработавший источник обязан оставить запись
 * в notes. Отсутствие роли и провал опроса роли — разные строки.
 *
 * ── Что исправлено в 1.1.1 по итогам приёмки на живых устройствах ──────────
 *
 * 1. РОЛИ. `cmd role get-role-holders` НЕ СУЩЕСТВУЕТ ни на SDK 30, ни на 31:
 *    `cmd role help` знает только add-role-holder / remove-role-holder /
 *    clear-role-holders — геттера у сервиса ролей нет вообще. Ярус был
 *    спроектирован на команду, которой нет, и не работал НИ НА ОДНОМ
 *    устройстве. Активная дыра: com.google.android.tv.remote.service (роль
 *    SYSTEM_TELEVISION_REMOTE_SERVICE) не попадал в защиту, а Shield и TiVo
 *    заведены в HA через androidtv_remote — отключение тихо убило бы обе
 *    интеграции, и канарейка по аккаунтам этого НЕ ловит (аккаунты Google на
 *    месте, пульт мёртв). Рабочий источник — `dumpsys role`, отдаёт
 *    `holders=` текстом. Проверено на TiVo (SDK 31).
 *
 * 2. INSTALLER. resolve-activity звался с `-d file:///x.apk`, а Android 10+
 *    (SDK 29+) такой URI для install-интента не резолвит вообще — ответ
 *    "No activity found". С `content://` резолвится штатно. Хуже самого
 *    промаха было то, что строка "No activity found" МОЛЧА ложилась в набор
 *    как имя пакета: результат resolve-activity никак не валидировался.
 *    Теперь каждый выведенный источник проходит looksLikePackage().
 *
 * 3. LOCALE. `ro.product.locale` на Fire OS 7 ПУСТОЙ, а разбор вывода шёл
 *    регуляркой `#locale\s*\n([^\n]*)`: на пустом значении жадный \s*
 *    съедал оба перевода строки и захватывал СЛЕДУЮЩИЙ маркер — поле locale
 *    равнялось литеральной строке "#model". Это блокер для выбора
 *    config.<locale> при установке .apks, а не косметика. Теперь разбор идёт
 *    по маркерам через split (пустое значение однозначно), значение берётся
 *    по цепочке фолбэков и проверяется на похожесть на BCP-47.
 *
 * 4. DENSITY. `wm density` печатает Physical density и, если задан override,
 *    ещё и Override density. Старый разбор брал `tail -1`, то есть при
 *    заданном override — его, а без него — physical, и различить было
 *    нельзя. Теперь снимаются оба явно; эффективной считается override, если
 *    он есть. Побочно это единственное правдоподобное объяснение расхождения
 *    «213 dpi в вики против 320 живьём» на Fire TV.
 */

const { adbSh } = require('./adb.js');

// Ядро системы. Небольшой и намеренно консервативный — всё остальное
// добывается с устройства.
const CORE_PROTECTED = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.shell',
  'com.android.keychain',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  // Канал unicode-ввода самого аддона: отключив его, отстрелим adb_text.
  // Прямой аналог самозащиты канала в keenetic-mcp.
  'com.android.adbkeyboard',
];

const CORE_PREFIXES = [
  'com.android.providers.',   // settings, media, downloads, telephony...
  'com.android.inputmethod.',
];

/**
 * Эвристика по именам — ТОЛЬКО В ПЛЮС к выведенному, никогда вместо.
 * Шаблоны узкие намеренно: голое 'sso' ловит `pacprocessor` (proce-sso-r) —
 * поймано при разведке 07.08.
 */
const ACCOUNT_HINTS = [
  /(^|\.)dcp(\.|$)/i,        // com.amazon.dcp, com.amazon.dcp.contracts.*
  /identity\.auth/i,         // com.amazon.identity.auth.device.authorization
  /ottsso/i,                 // com.amazon.tv.ottssocompanionapp
  /ssocompanion/i,
  /accountmanager/i,
  /(^|\.)accounts?(\.|$)/i,
  /\bgsf\b|android\.gms$/i,  // Google-стек на TiVo/Shield
];

// Имя пакета Android: латиница/цифры/подчёркивания, минимум одна точка,
// без пробелов. Отсекает "No activity found", "Unknown command: ...",
// "Error: ..." и прочий текст ошибок, который иначе молча попадёт в набор.
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

// Похожесть на BCP-47: ru, en-US, sr-Latn-RS, es-419.
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$/;

const MARK = '@@';

function looksLikePackage(s) {
  const v = String(s || '').trim();
  return !!v && v !== 'null' && v.length <= 255 && PKG_RE.test(v);
}

function pkgOf(component) {
  const s = String(component || '').trim();
  if (!s || s === 'null') return null;
  return s.split('/')[0].trim() || null;
}

/**
 * Разобрать вывод, размеченный строками вида @@ключ@@.
 * Split с одной группой захвата даёт [преамбула, ключ, значение, ключ, ...],
 * поэтому пустое значение представимо однозначно — в отличие от разбора
 * регуляркой, на котором сломался locale в 1.1.0.
 */
function splitMarked(out) {
  const parts = String(out).split(new RegExp(`^${MARK}([a-z0-9_]+)${MARK}[ \\t]*\\r?$`, 'm'));
  const map = {};
  for (let i = 1; i < parts.length; i += 2) {
    map[parts[i]] = String(parts[i + 1] === undefined ? '' : parts[i + 1]).trim();
  }
  return map;
}

function markedCommand(queries) {
  return Object.entries(queries)
    .map(([k, c]) => `echo "${MARK}${k}${MARK}"; ${c} 2>/dev/null`)
    .join('; ') + `; echo "${MARK}end${MARK}"`;
}

/** Базовые свойства устройства — одним вызовом. */
async function getProps(serial) {
  const out = await adbSh(serial, markedCommand({
    sdk: 'getprop ro.build.version.sdk',
    abilist: 'getprop ro.product.cpu.abilist',
    abi: 'getprop ro.product.cpu.abi',
    model: 'getprop ro.product.model',
    // Цепочка локали: сначала то, что реально выставлено пользователем
    // (именно в этой локали работает приложение и по ней выбирается сплит),
    // потом заводское значение, потом сборка из language+region.
    locale_persist: 'getprop persist.sys.locale',
    locale_product: 'getprop ro.product.locale',
    locale_language: 'getprop ro.product.locale.language',
    locale_region: 'getprop ro.product.locale.region',
    // Плотность: physical и override снимаются РАЗДЕЛЬНО, см. шапку модуля.
    density_physical: 'wm density | sed -n "s/^ *Physical density: *\\([0-9][0-9]*\\).*/\\1/p" | head -1',
    density_override: 'wm density | sed -n "s/^ *Override density: *\\([0-9][0-9]*\\).*/\\1/p" | head -1',
    density_prop: 'getprop ro.sf.lcd_density',
  }));

  const m = splitMarked(out);
  const num = v => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const sdk = parseInt(m.sdk, 10);

  // Локаль: первый кандидат, похожий на BCP-47. Мусор не пропускаем.
  const localeCandidates = [
    m.locale_persist,
    m.locale_product,
    (m.locale_language && m.locale_region) ? `${m.locale_language}-${m.locale_region}` : '',
    m.locale_language,
  ];
  let locale = '';
  for (const c of localeCandidates) {
    const v = String(c || '').trim();
    if (v && LOCALE_RE.test(v)) { locale = v; break; }
  }

  const densityPhysical = num(m.density_physical) || num(m.density_prop);
  const densityOverride = num(m.density_override);

  const abilist = String(m.abilist || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!abilist.length && m.abi) abilist.push(String(m.abi).trim());

  const notes = [];
  if (!locale) notes.push('локаль устройства определить не удалось — выбор config.<locale> при установке сплитов будет пропущен');
  if (!densityPhysical) notes.push('плотность экрана определить не удалось — выбор config.<density> будет пропущен');
  if (densityOverride && densityPhysical && densityOverride !== densityPhysical)
    notes.push(`задан Override density ${densityOverride} при физической ${densityPhysical} — сплиты выбираются по override`);

  return {
    sdk: Number.isFinite(sdk) ? sdk : 0,
    abilist,
    locale,
    model: m.model || '',
    density: densityOverride || densityPhysical || null,
    density_physical: densityPhysical || null,
    density_override: densityOverride || null,
    notes,
  };
}

/** Все установленные пакеты + подмножество системных и отключённых. */
async function listPackages(serial) {
  const out = await adbSh(serial, markedCommand({
    all: 'pm list packages',
    system: 'pm list packages -s',
    disabled: 'pm list packages -d',
  }));

  const m = splitMarked(out);
  const section = key => String(m[key] || '').split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('package:'))
    .map(l => l.slice('package:'.length).trim())
    .filter(Boolean);

  const all = section('all');
  return {
    all,
    system: new Set(section('system')),
    disabled: new Set(section('disabled')),
  };
}

/**
 * Снимок аккаунтов — канарейка деблоата.
 *
 * Возвращает ТОЛЬКО количество и типы: имена аккаунтов из `dumpsys account`
 * в выдачу не попадают намеренно (это персональные данные, а для сравнения
 * до/после они не нужны).
 */
async function accountSnapshot(serial) {
  let out = '';
  try {
    out = await adbSh(serial,
      'dumpsys account 2>/dev/null | sed -n "s/.*Account {.*type=\\([^}]*\\)}.*/\\1/p"');
  } catch {
    return { available: false, count: null, types: [] };
  }
  const types = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!types.length) {
    // Пусто может значить и «аккаунтов нет», и «dumpsys недоступен shell'у».
    // Различаем по наличию заголовка.
    let head = '';
    try { head = await adbSh(serial, 'dumpsys account 2>/dev/null | head -n 2'); } catch { /* ignore */ }
    if (!/User UserInfo|Accounts:/i.test(head)) return { available: false, count: null, types: [] };
  }
  const byType = {};
  for (const t of types) byType[t] = (byType[t] || 0) + 1;
  return { available: true, count: types.length, types: byType };
}

/**
 * Держатели ролей через `dumpsys role`.
 *
 * Именно ЧЕРЕЗ DUMPSYS, а не `cmd role`: у сервиса ролей нет геттера
 * (см. шапку модуля). Сервис появился в SDK 29, на более старых прошивках
 * его нет вовсе — это не ошибка, а факт про платформу, и он различается в
 * notes от настоящего провала опроса.
 *
 * Берутся держатели ВСЕХ ролей без разбора: роль по определению означает
 * «этот пакет выполняет системную функцию за всю систему». Список ролей
 * вендорозависим, и выбирать из него «важные» — ровно та ошибка, которая
 * привела к инциденту 25.07.
 */
async function roleHolders(serial, sdk) {
  if (!(sdk >= 29))
    return { holders: [], detail: {}, note: `сервиса ролей нет на этой платформе (SDK ${sdk || '?'} < 29) — роли не опрашивались, это норма` };

  let out = '';
  try {
    out = await adbSh(serial, 'dumpsys role');
  } catch (e) {
    return { holders: [], detail: {}, note: `⚠ dumpsys role не отработал (${e.message}) — РОЛИ НЕ УЧТЕНЫ В ЗАЩИТЕ` };
  }

  if (!/ROLE STATE|roles=|name=android\.app\.role/i.test(out))
    return { holders: [], detail: {}, note: '⚠ dumpsys role не вернул состояние ролей — РОЛИ НЕ УЧТЕНЫ В ЗАЩИТЕ' };

  // Блоки вида:  { name=android.app.role.HOME \n holders=pkg[,pkg] }
  // Режем по границе блока, а не ловим окном фиксированной длины:
  // у последней роли следующего name= нет, и любой лимит по символам
  // молча теряет её держателя — ровно тот класс тихой дыры, что чиним.
  const detail = {};
  const holders = new Set();
  for (const chunk of String(out).split(/(?=name=android\.app\.role\.)/)) {
    const rm = /^name=(android\.app\.role\.[A-Z_0-9]+)/.exec(chunk);
    if (!rm) continue;
    const hm = /holders=([^\r\n}]+)/.exec(chunk);
    if (!hm) continue;
    const list = hm[1].split(',').map(s => s.trim()).filter(looksLikePackage);
    if (!list.length) continue;
    detail[rm[1].replace('android.app.role.', '')] = list;
    list.forEach(p => holders.add(p));
  }

  if (!holders.size)
    return { holders: [], detail: {}, note: 'dumpsys role отработал, но держателей ролей на устройстве нет' };

  return { holders: Array.from(holders).sort(), detail, note: null };
}

/**
 * Вывести protected-набор с устройства.
 * Каждый источник опрашивается отдельно, не роняет остальные И ОБЯЗАН
 * оставить след в notes, если не сработал.
 */
async function protectedSet(serial, opts = {}) {
  const props = opts.props || await getProps(serial);
  const sources = {};
  const notes = [];

  /** Опросить источник, провалидировать и записать провал в notes. */
  async function derive(key, cmd, extract, humanName) {
    let out;
    try {
      out = await adbSh(serial, cmd);
    } catch (e) {
      notes.push(`⚠ ${humanName}: опрос не удался (${e.message}) — источник НЕ УЧТЁН В ЗАЩИТЕ`);
      return;
    }
    const raw = extract(out);
    const pkg = pkgOf(raw);
    if (!looksLikePackage(pkg)) {
      notes.push(`⚠ ${humanName}: определить не удалось (ответ: ${JSON.stringify(String(raw || '').slice(0, 80))}) — источник НЕ УЧТЁН В ЗАЩИТЕ`);
      return;
    }
    sources[key] = pkg;
  }

  const lastLine = out => String(out).trim().split('\n').filter(Boolean).pop() || '';

  // Лаунчер — resolve-activity есть уже на SDK 28
  await derive('launcher',
    'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null',
    lastLine, 'лаунчер');

  // Установщик пакетов. content:// — рабочая форма на SDK 29+; file:// там
  // не резолвится вообще, но остаётся фолбэком для старых прошивок.
  {
    const variants = [
      'cmd package resolve-activity --brief -a android.intent.action.INSTALL_PACKAGE -d content://x/y.apk 2>/dev/null',
      'cmd package resolve-activity --brief -a android.intent.action.INSTALL_PACKAGE -d file:///x.apk 2>/dev/null',
    ];
    let found = null;
    for (const v of variants) {
      try {
        const pkg = pkgOf(lastLine(await adbSh(serial, v)));
        if (looksLikePackage(pkg)) { found = pkg; break; }
      } catch { /* пробуем следующую форму */ }
    }
    if (found) sources.installer = found;
    else notes.push('⚠ установщик пакетов: определить не удалось ни через content://, ни через file:// — источник НЕ УЧТЁН В ЗАЩИТЕ');
  }

  // Активный IME
  await derive('ime', 'settings get secure default_input_method',
    out => String(out).trim(), 'активный IME');

  // Провайдер WebView
  await derive('webview', 'dumpsys webviewupdate 2>/dev/null | head -n 12',
    out => {
      const m = String(out).match(/Current WebView package \(name, version\):\s*\(([^,\s)]+)/);
      return m ? m[1] : '';
    }, 'провайдер WebView');

  // Роли
  const roles = await roleHolders(serial, props.sdk);
  if (roles.holders.length) {
    sources.roles = roles.holders;
    sources.roles_detail = roles.detail;
  }
  if (roles.note) notes.push(roles.note);

  // Стек аккаунта/регистрации — эвристика по именам, помечена как эвристика
  const pkgs = opts.packages || await listPackages(serial);
  const accountLike = pkgs.all.filter(p => ACCOUNT_HINTS.some(re => re.test(p)));
  if (accountLike.length) sources.account_like = accountLike;

  const set = new Set(CORE_PROTECTED);
  for (const p of pkgs.all) {
    if (CORE_PREFIXES.some(pref => p.startsWith(pref))) set.add(p);
  }
  for (const key of ['launcher', 'installer', 'ime', 'webview']) {
    if (sources[key]) set.add(sources[key]);
  }
  for (const p of roles.holders) set.add(p);
  for (const p of accountLike) set.add(p);

  if (accountLike.length)
    notes.push('account_like — эвристика по именам пакетов, проверяй глазами в dry_run');
  for (const n of (props.notes || [])) notes.push(n);

  return {
    packages: Array.from(set).sort(),
    sources,
    notes,
  };
}

module.exports = {
  CORE_PROTECTED, CORE_PREFIXES, ACCOUNT_HINTS, PKG_RE, LOCALE_RE,
  getProps, listPackages, accountSnapshot, protectedSet, roleHolders,
  pkgOf, looksLikePackage, splitMarked, markedCommand,
};
