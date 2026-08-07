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
 * Ярусность обязательна: на Fire OS 7 (SDK 28) сервиса ролей НЕТ
 * (`cmd role` -> "Can't find service: role", появился в SDK 29), поэтому
 * каждый источник опрашивается независимо и молча пропускается, если его на
 * этой прошивке нет. Проверено живьём 2026-08-07, см. diagnostics_2026-08-07.
 */

const { adbSh, sq } = require('./adb.js');

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

const ROLES = [
  'android.app.role.HOME',
  'android.app.role.ASSISTANT',
  'android.app.role.BROWSER',
];

function pkgOf(component) {
  const s = String(component || '').trim();
  if (!s || s === 'null') return null;
  return s.split('/')[0] || null;
}

/** Базовые свойства устройства — одним вызовом. */
async function getProps(serial) {
  const out = await adbSh(serial, [
    'echo "#sdk"; getprop ro.build.version.sdk',
    'echo "#abilist"; getprop ro.product.cpu.abilist',
    'echo "#locale"; getprop ro.product.locale',
    'echo "#model"; getprop ro.product.model',
    'echo "#density"; wm density 2>/dev/null | sed -n "s/.*[Dd]ensity: *\\([0-9]*\\).*/\\1/p" | tail -1',
  ].join('; '));

  const pick = key => {
    const m = out.match(new RegExp(`#${key}\\s*\\n([^\\n]*)`));
    return m ? m[1].trim() : '';
  };
  const sdk = parseInt(pick('sdk'), 10);
  return {
    sdk: Number.isFinite(sdk) ? sdk : 0,
    abilist: pick('abilist').split(',').map(s => s.trim()).filter(Boolean),
    locale: pick('locale'),
    model: pick('model'),
    density: parseInt(pick('density'), 10) || null,
  };
}

/** Все установленные пакеты + подмножество системных и отключённых. */
async function listPackages(serial) {
  const out = await adbSh(serial, [
    'echo "#all"; pm list packages 2>/dev/null',
    'echo "#system"; pm list packages -s 2>/dev/null',
    'echo "#disabled"; pm list packages -d 2>/dev/null',
  ].join('; '));

  const section = key => {
    const re = new RegExp(`#${key}\\n([\\s\\S]*?)(?=\\n#|$)`);
    const m = out.match(re);
    if (!m) return [];
    return m[1].split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('package:'))
      .map(l => l.slice('package:'.length).trim())
      .filter(Boolean);
  };

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
 * Вывести protected-набор с устройства.
 * Каждый источник опрашивается отдельно и не роняет остальные.
 */
async function protectedSet(serial, opts = {}) {
  const props = opts.props || await getProps(serial);
  const sources = {};
  const add = (key, value) => {
    const p = pkgOf(value);
    if (p) sources[key] = p;
    return p;
  };

  // Лаунчер и установщик — через resolve-activity (есть уже на SDK 28)
  try {
    const out = await adbSh(serial,
      'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1');
    add('launcher', out.trim());
  } catch { /* источник недоступен — пропускаем */ }

  try {
    const out = await adbSh(serial,
      'cmd package resolve-activity --brief -a android.intent.action.INSTALL_PACKAGE -d file:///x.apk 2>/dev/null | tail -n 1');
    add('installer', out.trim());
  } catch { /* ignore */ }

  // Активный IME
  try {
    const out = await adbSh(serial, 'settings get secure default_input_method');
    add('ime', out.trim());
  } catch { /* ignore */ }

  // Провайдер WebView
  try {
    const out = await adbSh(serial, 'dumpsys webviewupdate 2>/dev/null | head -n 12');
    const m = out.match(/Current WebView package \(name, version\):\s*\(([^,\s)]+)/);
    if (m) sources.webview = m[1];
  } catch { /* ignore */ }

  // Роли — только SDK 29+; на Fire OS 7 сервиса нет вообще
  const roleHolders = [];
  if (props.sdk >= 29) {
    for (const role of ROLES) {
      try {
        const out = await adbSh(serial, `cmd role get-role-holders ${sq(role)} 2>/dev/null`);
        if (/Can't find service/i.test(out)) break;
        out.split('\n').map(s => s.trim()).filter(Boolean)
          .filter(s => /^[a-z][\w.]*\.[\w.]+$/i.test(s))
          .forEach(p => roleHolders.push(p));
      } catch { /* ignore */ }
    }
  }
  if (roleHolders.length) sources.roles = Array.from(new Set(roleHolders));

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
  for (const p of (sources.roles || [])) set.add(p);
  for (const p of accountLike) set.add(p);

  return {
    packages: Array.from(set).sort(),
    sources,
    notes: [
      props.sdk >= 29 ? null : 'cmd role недоступен (SDK < 29) — роли не опрашивались',
      accountLike.length ? 'account_like — эвристика по именам пакетов, проверяй глазами в dry_run' : null,
    ].filter(Boolean),
  };
}

module.exports = {
  CORE_PROTECTED, CORE_PREFIXES, ACCOUNT_HINTS,
  getProps, listPackages, accountSnapshot, protectedSet, pkgOf,
};
