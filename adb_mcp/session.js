'use strict';
/**
 * session.js — управление adb-сессией и диагностика устройства.
 * Перенесено из монолита server.js v1.0.0 без изменений поведения.
 */

const { adb, withSerial, sq, text } = require('./adb.js');

const ALLOW_SHELL = process.env.ALLOW_SHELL !== 'false';
const ADB_TIMEOUT_MS = 30000;

async function devices() {
  const out = await adb(['devices', '-l']);
  return text(out.trim() || 'No devices');
}

async function connect(args) {
  const host = args.host.includes(':') ? args.host : `${args.host}:5555`;
  const out = (await adb(['connect', host], { timeout: 10000 })).toString().trim();
  // adb пишет неуспех коннекта в stdout с exit 0 — превращаем в ошибку
  if (/failed to connect|unable to connect|cannot connect/i.test(out))
    throw new Error(`${out}. Check the device is awake and the port is current (wireless-debug ports change after device reboot).`);
  return text(out);
}

async function pair(args) {
  // Wireless Debugging (Android 11+): порт pairing-диалога рандомный,
  // дефолта нет — требуем ip:port явно.
  if (!String(args.host).includes(':'))
    throw new Error('Pairing requires ip:port — the random port from the "Pair device with pairing code" dialog (not 5555)');
  const out = await adb(['pair', String(args.host), String(args.code)], { timeout: 20000 });
  return text(out.trim());
}

async function disconnect(args) {
  const out = await adb(args.host ? ['disconnect', args.host] : ['disconnect'], { timeout: 10000 });
  return text(out.trim() || 'Disconnected');
}

async function shell(args) {
  if (!ALLOW_SHELL) throw new Error('adb_shell is disabled in addon config (allow_shell: false)');
  const timeout = args.timeout_sec ? Math.min(args.timeout_sec * 1000, 120000) : ADB_TIMEOUT_MS;
  const out = await adb(withSerial(args.serial, ['shell', args.command]), { timeout });
  return text(out.toString().trim() || '(empty output)');
}

async function logcat(args) {
  const serial = args.serial;
  const lines = Math.min(args.lines || 200, 2000);
  const raw = (args.filter || '').trim();
  let out;

  if (!raw) {
    out = (await adb(withSerial(serial, ['logcat', '-d', '-t', String(lines)]), { timeout: 20000 })).toString();
  } else if (/[:*]/.test(raw)) {
    // filterspec: фильтр по ВСЕМУ буферу, tail НА УСТРОЙСТВЕ. С -t N logcat
    // сначала режет буфер до N сырых строк и лишь потом фильтрует (баг
    // v0.2.0 — пустой вывод). Без *:S несматченные теги не глушатся.
    const spec = raw.split(/\s+/);
    if (!spec.some(x => x.startsWith('*'))) spec.push('*:S');
    const cmd = `logcat -d ${spec.map(sq).join(' ')} 2>/dev/null | tail -n ${lines}`;
    out = (await adb(withSerial(serial, ['shell', cmd]), { timeout: 20000 })).toString();
  } else {
    // substring: регистронезависимый grep НА УСТРОЙСТВЕ. Fire OS подменяет
    // /system/bin/grep на BSD grep 2.5.1-FreeBSD, который после бинарных
    // байтов crash-буфера матчит ВСЁ — используем toybox grep, когда есть.
    // Финальный `:` — 0 совпадений это пустой результат, а не ошибка exit 1.
    const cmd = `G="grep"; command -v toybox >/dev/null 2>&1 && toybox grep --help >/dev/null 2>&1 && G="toybox grep"; ` +
      `logcat -d 2>/dev/null | $G -iF -- ${sq(raw)} | tail -n ${lines}; :`;
    out = (await adb(withSerial(serial, ['shell', cmd]), { timeout: 20000 })).toString();
  }
  return text(out.trim().slice(-64000) || '(empty)');
}

module.exports = { devices, connect, pair, disconnect, shell, logcat, ALLOW_SHELL };
