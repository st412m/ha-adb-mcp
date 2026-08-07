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
 */

const fs = require('fs');
const path = require('path');
const {
  adb, adbSh, withSerial, sq, text, json,
  coerceArray, coerceBool, resolveSafeHostPath, ensureDir, sanitizeSerial,
} = require('./adb.js');
const { getProps, listPackages, accountSnapshot, protectedSet } = require('./device.js');

const ALLOW_UNINSTALL = process.env.ALLOW_UNINSTALL === 'true';
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

async function packageVersion(serial, pkg) {
  const out = await adbSh(serial,
    `dumpsys package ${sq(pkg)} 2>/dev/null | grep -m2 -E "versionCode=|versionName=|primaryCpuAbi="`);
  const code = (out.match(/versionCode=(\d+)/) || [])[1] || '0';
  const name = (out.match(/versionName=([^\s]+)/) || [])[1] || '';
  const abi = (out.match(/primaryCpuAbi=([^\s]+)/) || [])[1] || '';
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
  if (!remote.length) throw new Error(`pm path вернул пусто для ${pkg} — пакет не установлен?`);
  const ver = await packageVersion(serial, pkg);
  const dir = path.join(deviceDir(args, serial), 'apk', pkg, ver.versionCode || '0');
  ensureDir(dir);

  const files = [];
  for (const r of remote) {
    const base = path.basename(r);
    const local = path.join(dir, base);
    await adb(withSerial(serial, ['pull', r, local]), { timeout: 180000 });
    const size = fs.existsSync(local) ? fs.statSync(local).size : 0;
    if (!size) throw new Error(`Бэкап ${pkg}: файл ${base} вытянулся пустым`);
    files.push({ name: base, size, device_path: r });
  }

  const manifest = {
    package: pkg,
    versionName: ver.versionName,
    versionCode: ver.versionCode,
    primaryCpuAbi: ver.primaryCpuAbi,
    splits: files.map(f => f.name),
    files,
    device: { serial, model: props.model, sdk: props.sdk, density: props.density, locale: props.locale },
    pulled_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifest };
}

async function installFromBackupDir(serial, dir) {
  const apks = fs.readdirSync(dir).filter(f => f.endsWith('.apk')).map(f => path.join(dir, f));
  if (!apks.length) throw new Error(`В ${dir} нет ни одного .apk`);
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
      `аккаунтов было ${baseline.accounts.count}, стало ${acc.count} — потеряна регистрация устройства`);
  }

  try {
    const home = await adbSh(serial,
      'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1');
    result.launcher = home.trim();
    if (!result.launcher || /no activity|null/i.test(result.launcher)) {
      result.ok = false;
      result.problems.push('лаунчер больше не резолвится — устройство останется без домашнего экрана');
    }
  } catch (e) {
    result.ok = false;
    result.problems.push(`лаунчер не проверить: ${e.message}`);
  }

  return result;
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
    `filter=${filter}${q ? ` q=${q}` : ''} — ${list.length} of ${pkgs.all.length} packages\n\n` +
    (lines.join('\n') || '(none)'));
}

async function actInfo(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error('action=info требует packages');
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

async function actLaunch(serial, args) {
  const pkg = coerceArray(args.packages || args.package)[0];
  if (!pkg) throw new Error('action=launch требует packages');
  // monkey запускает главную активность, не требуя знать её имя
  const out = await adbSh(serial,
    `monkey -p ${sq(pkg)} -c android.intent.category.LAUNCHER 1 2>&1 | tail -n 3`);
  if (/No activities found|Error/i.test(out))
    throw new Error(`Не удалось запустить ${pkg}: ${out.trim()}`);
  return text(`Launched ${pkg}\n${out.trim()}`);
}

async function actStopOrClear(serial, args, action) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error(`action=${action} требует packages`);
  const dryRun = coerceBool(args.dry_run, action === 'clear');  // clear стирает данные — по умолчанию dry_run
  if (dryRun) {
    return text(`dry_run: ${action} для ${packages.length} пакет(ов):\n` +
      packages.map(p => `  ${p}`).join('\n') +
      `\n\nПовтори с dry_run=false, чтобы применить.`);
  }
  const done = [];
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
  if (!packages.length) throw new Error('action требует packages');

  const mode = String(args.mode || 'disable').toLowerCase();
  if (!['disable', 'uninstall'].includes(mode))
    throw new Error(`mode должен быть disable или uninstall, получено: ${mode}`);
  if (mode === 'uninstall' && !ALLOW_UNINSTALL)
    throw new Error(
      'mode=uninstall запрещён конфигурацией аддона (allow_uninstall: false). ' +
      'Включи опцию в настройках аддона и перезапусти его, если действительно нужно удаление, ' +
      'а не обратимое отключение (mode=disable).');

  const dryRun = coerceBool(args.dry_run, true);
  const doCanary = coerceBool(args.canary, true);
  const doBackup = coerceBool(args.backup, mode === 'uninstall');
  const force = coerceBool(args.force, false);
  const batchSize = Math.max(1, Math.min(parseInt(args.batch_size, 10) || DEFAULT_BATCH, 25));

  const props = await getProps(serial);
  const pkgs = await listPackages(serial);
  const prot = await protectedSet(serial, { props, packages: pkgs });

  const unknown = packages.filter(p => !pkgs.all.includes(p));
  if (unknown.length)
    throw new Error(`Не установлены на устройстве: ${unknown.join(', ')}`);

  const hit = packages.filter(p => prot.packages.includes(p));
  if (hit.length)
    throw new Error(
      `ОТКАЗ: в списке защищённые пакеты — ${hit.join(', ')}.\n` +
      `Источники защиты: ${JSON.stringify(prot.sources)}\n` +
      `Ничего не выполнено (целиком, а не частично). ` +
      `Если уверен — убери их из списка вручную, обхода в инструменте нет.`);

  const plan = packages.map(p => ({
    package: p,
    system: pkgs.system.has(p),
    already_disabled: pkgs.disabled.has(p),
    action: mode,
    backup: doBackup && !pkgs.system.has(p) ? 'да (пользовательский пакет)'
      : doBackup ? 'да (системный — APK сохраняется, но ставится обратно через install-existing)' : 'нет',
    rollback: mode === 'disable' ? 'pm enable'
      : pkgs.system.has(p) ? 'cmd package install-existing' : 'установка из бэкапа APK',
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
      plan,
      hint: 'Повтори с dry_run=false. Откат: adb_app action=restore.',
    });
  }

  if (mode === 'uninstall' && !doBackup && !force)
    throw new Error('mode=uninstall с backup=false требует force=true — иначе откат возможен не для всех пакетов');

  const state = readState(args, serial);
  const report = { mode, applied: [], failed: [], stopped: false, canary: [] };

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
            if (!force) throw new Error(`бэкап не удался (${e.message}) — прерываю, повтори с force=true, если это осознанно`);
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
            report.failed.push({ package: e.package, error: `откат не удался: ${err.message}` });
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
  report.next = 'Проверь устройство глазами: домашний экран, магазин, вход в аккаунт. ' +
    'После ребута проверь ещё раз — часть отказов проявляется только на следующей загрузке.';
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
  if (!entry.backup) throw new Error(`нет бэкапа APK для ${entry.package} — восстановить нечем`);
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
      if (missing.length) throw new Error(`Нет в снапшоте: ${missing.join(', ')}. Для прямого включения используй action=enable.`);
    }
  }

  if (!targets.length) return text('Снапшот пуст — восстанавливать нечего.');

  if (dryRun) {
    return json({
      dry_run: true,
      state_file: statePath(args, serial),
      plan: targets.map(e => ({
        package: e.package,
        was: e.mode,
        how: e.mode === 'disable' ? 'pm enable'
          : e.system ? 'cmd package install-existing' : `установка из ${e.backup || '— бэкапа нет!'}`,
      })),
      hint: 'Повтори с dry_run=false.',
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
    else throw new Error('action=backup требует packages либо scope=user|all');
  }

  const dryRun = coerceBool(args.dry_run, false);
  if (dryRun) {
    return text(`dry_run: будет сохранено ${packages.length} пакет(ов) в ` +
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
      const prot = await protectedSet(serial, { props });
      return json({ device: props, ...prot });
    }
    default:
      throw new Error(`Неизвестный action: ${action || '(пусто)'}. ` +
        `Допустимые: list, info, protected, launch, stop, clear, disable, uninstall, enable, restore, backup, state`);
  }
}

module.exports = { adbApp, ALLOW_UNINSTALL, DEFAULT_STORE };
