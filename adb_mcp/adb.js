'use strict';
/**
 * adb.js — низкоуровневая обвязка вокруг бинаря adb.
 *
 * Здесь всё, что не знает про конкретные инструменты: запуск команд, разбор
 * типовых ошибок в подсказки, экранирование для device-shell, проверка путей
 * на стороне HA и коэрсинг аргументов MCP-клиента.
 *
 * Поведение перенесено из монолитного server.js v1.0.0 ДОСЛОВНО — правки
 * только там, где это отмечено комментарием.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// push/pull ограничены этими корнями на стороне HA
const FILE_ROOTS = ['/media', '/share'];

const ADB_TIMEOUT_MS = 30000;
const ADB_MAX_BUFFER = 16 * 1024 * 1024;

// v0.3.1: типовые ошибки adb дополняются подсказкой для вызывающего
function friendlyAdbError(msg) {
  if (/device '.*' not found|no devices\/emulators found/i.test(msg))
    return `${msg}. Call adb_devices to list what is connected; network devices may need adb_connect first (wireless-debug ports change after phone reboot).`;
  if (/device offline/i.test(msg))
    return `${msg}. The TCP session died (device slept or rebooted) - run adb_disconnect for this host, then adb_connect again.`;
  if (/device unauthorized|failed to authenticate/i.test(msg))
    return `${msg}. Confirm the "Allow USB debugging?" RSA prompt on the device screen (check "Always allow").`;
  if (/INSTALL_FAILED_VERIFICATION_FAILURE/i.test(msg))
    return `${msg}. The on-device package verifier rejects ADB installs - disable it once via adb_shell: settings put global verifier_verify_adb_installs 0`;
  return msg;
}

/**
 * 1.4.0: текст ошибки adb — чистая функция, проверяется `node -e` без adb.
 *
 * Непустой stderr — как было (stderr + хвост stdout). При ПУСТОМ stderr
 * раньше уходил `err.message`, то есть `Command failed: adb <весь argv>`:
 * агент не узнавал, что случилось (таймаут? kill?), а argv нёс аргументы
 * вызова. Теперь текст строится из полей execFile и называет только
 * подкоманду adb, а не argv. redact() в server.js остаётся вторым слоем.
 *
 * maxBuffer проверяется ПЕРВЫМ: Node 22 отдаёт его строковым кодом
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER без `killed`, и
 * без отдельной ветки он читался бы как «adb could not start».
 */
function describeAdbFailure(err, stderr, stdout, args, opts = {}) {
  let msg = (stderr || '').toString().trim();
  const out = opts.binary ? '' : (stdout || '').toString().trim();
  if (!msg) {
    const a = args || [];
    const sub = (a[0] === '-s' ? a[2] : a[0]) || '(no subcommand)';
    const e = err || {};
    const secs = +((opts.timeout || ADB_TIMEOUT_MS) / 1000).toFixed(3);
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      msg = `adb ${sub} output exceeded ${ADB_MAX_BUFFER / 1024 / 1024} MB and was killed`;
    else if (e.killed === true)
      msg = `adb ${sub} timed out after ${secs} s and was killed${e.signal ? ` (${e.signal})` : ''}`;
    else if (e.signal)
      msg = `adb ${sub} was terminated by ${e.signal}`;
    else if (typeof e.code === 'number')
      msg = out ? `adb ${sub} exited with code ${e.code}` : `adb ${sub} exited with code ${e.code} and printed nothing`;
    else if (typeof e.code === 'string')
      msg = `adb could not start: ${e.code}`;
    else
      msg = `adb ${sub} failed without output`;
  }
  // v0.3.2: не терять stdout при exit!=0 — при отладке shell-пайплайнов
  // сообщение об ошибке без вывода команды бесполезно.
  if (out) msg = `${msg}\nstdout (tail): ${out.slice(-2000)}`;
  return friendlyAdbError(msg);
}

function adb(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('adb', args, {
      timeout: opts.timeout || ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
      encoding: opts.binary ? 'buffer' : 'utf8',
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(describeAdbFailure(err, stderr, stdout, args, opts)));
      resolve(opts.withStderr ? { stdout, stderr } : stdout);
    });
  });
}

function withSerial(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

// Экранирование одинарными кавычками для шелла УСТРОЙСТВА
function sq(x) {
  return `'${String(x).replace(/'/g, `'\\''`)}'`;
}

/**
 * Выполнить команду в шелле устройства и вернуть stdout строкой.
 *
 * ⚠ tolerant (по умолчанию ВКЛЮЧЕН) дописывает в конец `; :`. Без этого
 * последняя команда цепочки определяет код возврата всего вызова, и любой
 * `grep` без совпадений (exit 1) роняет запрос целиком с бесполезным
 * "Command failed". Тот же класс, что баг adb_logcat в 0.3.2; на нём же
 * упал первый пробный вызов разведки 2026-08-07.
 */
async function adbSh(serial, cmd, opts = {}) {
  const body = opts.tolerant === false ? cmd : `${cmd}; :`;
  const out = await adb(withSerial(serial, ['shell', body]), opts);
  return out.toString();
}

function text(t) { return [{ type: 'text', text: t }]; }

function json(obj) { return text(JSON.stringify(obj, null, 2)); }

// input text: adb требует экранирования пробелов и спецсимволов
function escapeInputText(s) {
  return s
    .replace(/[\\%&()<>|;$*'"`#!~\[\]{}^]/g, m => '\\' + m)
    .replace(/ /g, '%s');
}

// v0.5.1: MCP-клиент claude.ai сериализует array-параметры JSON-строками
// (тот же баг, что ha-filesystem-mcp issue #2, фикс 2.2.2).
function coerceArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* не JSON — трактуем как одиночное значение */ }
    }
  }
  return [v];
}

// Тот же коэрсинг для булевых: MCP-клиент может прислать "true"/"false"
function coerceBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

// 1.3.0: тот же баг клиента claude.ai, что coerceArray (урок 0.5.1) — объекты
// сериализуются JSON-строкой точно так же, как массивы. Нужен для adb_app
// action=launch extras.
function coerceObject(v) {
  if (v === undefined || v === null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {};
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* не JSON — падаем в отказ ниже */ }
    }
  }
  throw new Error(`extras: expected a key-value object, got ${JSON.stringify(v).slice(0, 120)}`);
}

function resolveSafeHostPath(p) {
  const resolved = path.resolve(p);
  if (!FILE_ROOTS.some(root => resolved === root || resolved.startsWith(root + '/')))
    throw new Error(`Access denied (host path outside ${FILE_ROOTS.join(', ')}): ${p}`);
  return resolved;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// serial вида 192.0.2.50:5555 -> 192.0.2.50_5555 (для имён каталогов)
function sanitizeSerial(serial) {
  return String(serial || 'default').replace(/[^\w.\-]+/g, '_');
}

module.exports = {
  FILE_ROOTS, ADB_TIMEOUT_MS, ADB_MAX_BUFFER,
  adb, adbSh, withSerial, friendlyAdbError, describeAdbFailure,
  sq, text, json, escapeInputText,
  coerceArray, coerceBool, coerceObject,
  resolveSafeHostPath, ensureDir, sanitizeSerial,
};
