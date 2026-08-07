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
    return `${msg}. The TCP session died (device slept or rebooted) — run adb_disconnect for this host, then adb_connect again.`;
  if (/device unauthorized|failed to authenticate/i.test(msg))
    return `${msg}. Confirm the "Allow USB debugging?" RSA prompt on the device screen (check "Always allow").`;
  if (/INSTALL_FAILED_VERIFICATION_FAILURE/i.test(msg))
    return `${msg}. The on-device package verifier rejects ADB installs — disable it once via adb_shell: settings put global verifier_verify_adb_installs 0`;
  return msg;
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

// serial вида 192.168.1.62:5555 -> 192.168.1.62_5555 (для имён каталогов)
function sanitizeSerial(serial) {
  return String(serial || 'default').replace(/[^\w.\-]+/g, '_');
}

module.exports = {
  FILE_ROOTS, ADB_TIMEOUT_MS, ADB_MAX_BUFFER,
  adb, adbSh, withSerial, friendlyAdbError,
  sq, text, json, escapeInputText,
  coerceArray, coerceBool,
  resolveSafeHostPath, ensureDir, sanitizeSerial,
};
