'use strict';
/**
 * files.js — установка/удаление APK и обмен файлами с устройством.
 * Перенесено из монолита server.js v1.0.0 без изменений поведения.
 */

const fs = require('fs');
const path = require('path');
const { adb, withSerial, text, coerceArray, resolveSafeHostPath } = require('./adb.js');

async function install(args) {
  // v0.5.0: apk_path — строка ИЛИ массив путей. Массив (>1) -> install-multiple.
  const rawPaths = coerceArray(args.apk_path).filter(p => typeof p === 'string' && p.trim() !== '');
  if (rawPaths.length === 0) throw new Error('apk_path is empty');
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

module.exports = { install, uninstall, push, pull };
