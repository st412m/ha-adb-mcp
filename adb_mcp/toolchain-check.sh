#!/bin/sh
# Проверка тулчейна аддона. Запускается ДВАЖДЫ:
#   /toolchain-check.sh build    — на сборке образа: падает, если версии ушли,
#                                  если конвейер скриншота не работает или
#                                  если недостаёт модуля сервера
#   /toolchain-check.sh runtime  — на старте: печатает баннер версий в лог
#
# Зачем: 21.07.2026 три релиза подряд (0.3.3-0.3.5) были сломаны в проде из-за
# поведения внешних утилит, а не кода, и диагностика шла вслепую, потому что
# версии тулчейна нигде не фиксировались. Теперь они видны в логе с первой
# секунды, а нерабочий конвейер ловится на сборке, а не в бою.
set -eu

# Ожидаемые мажоры (Alpine 3.22-stable на 2026-07-21, сверено по aports:
# nodejs 22.23.0-r0, android-tools 35.0.2-r16, imagemagick 7.1.2.15-r0).
# Патчи внутри ветки допустимы, смена мажора — нет.
EXPECT_NODE_MAJOR=22
EXPECT_IM_MAJOR=7
EXPECT_ADB_MAJOR=35

# Модули сервера (1.1.0+). Список продублирован в Dockerfile строками COPY —
# держать синхронно. Забытый COPY = падение на require() в бою, поэтому
# проверяется на сборке.
MODULES="proxy.js server.js registry.js adb.js device.js session.js ui.js files.js apps.js"

MANIFEST=/toolchain.txt

# IM7 переименовал convert -> magick; convert остаётся deprecated-обёрткой
im_bin() { if command -v magick >/dev/null 2>&1; then echo magick; else echo convert; fi; }

collect() {
  IM=$(im_bin)
  NODE_V=$(node -v 2>/dev/null | sed 's/^v//' || echo '?')
  ADB_V=$(adb --version 2>/dev/null | sed -n 's/^Version \([0-9][0-9.]*\).*/\1/p' | head -1)
  IM_V=$("$IM" -version 2>/dev/null | sed -n 's/^Version: ImageMagick \([0-9][0-9.-]*\).*/\1/p' | head -1)
  [ -n "${ADB_V:-}" ] || ADB_V='?'
  [ -n "${IM_V:-}" ] || IM_V='?'
}

major() { echo "$1" | sed 's/[.-].*//'; }

guard() {
  rc=0
  if [ "$(major "$NODE_V")" != "$EXPECT_NODE_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: nodejs $NODE_V, expected major $EXPECT_NODE_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$IM_V")" != "$EXPECT_IM_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: ImageMagick $IM_V, expected major $EXPECT_IM_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$ADB_V")" != "$EXPECT_ADB_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: android-tools $ADB_V, expected major $EXPECT_ADB_MAJOR" >&2; rc=1
  fi
  if [ "$rc" != 0 ]; then
    echo "" >&2
    echo "Build stopped: Alpine shipped a toolchain the add-on was not verified" >&2
    echo "against. Run adb_screenshot by hand, confirm it works, then update" >&2
    echo "EXPECT_*_MAJOR in toolchain-check.sh." >&2
    exit 1
  fi
}

# Модули: файл на месте + синтаксис + реальный импорт всего графа зависимостей.
# require('/registry.js') тянет session/ui/files/apps -> любой забытый COPY
# или опечатка в имени модуля падают здесь, а не у пользователя в рантайме.
modules_guard() {
  for m in $MODULES; do
    if [ ! -f "/$m" ]; then
      echo "MODULE GUARD: /$m is missing from the image - a COPY line in Dockerfile was forgotten" >&2
      exit 1
    fi
    if ! node --check "/$m" >/dev/null 2>&1; then
      echo "MODULE GUARD: syntax error in /$m" >&2
      node --check "/$m" >&2 || true
      exit 1
    fi
  done
  TOOL_COUNT=$(node -e 'process.stdout.write(String(require("/registry.js").TOOLS.length))' 2>/dev/null) || {
    echo "MODULE GUARD: /registry.js does not import - the require graph is broken" >&2
    node -e 'require("/registry.js")' >&2 || true
    exit 1
  }
  if [ -z "$TOOL_COUNT" ] || [ "$TOOL_COUNT" -lt 1 ] 2>/dev/null; then
    echo "MODULE GUARD: the tool registry is empty" >&2
    exit 1
  fi
}

# Смоук ровно того конвейера, которым работает adb_screenshot: file -> file.
smoke() {
  T=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$T'" EXIT

  "$IM" -size 200x120 gradient:blue-black "$T/s.png"
  "$IM" "$T/s.png" -resize '64x64>' -quality 30 "$T/s.jpg"
  [ -s "$T/s.jpg" ] || { echo "SMOKE FAIL: file->file produced an empty JPEG" >&2; exit 1; }
  head -c 2 "$T/s.jpg" | od -An -tx1 | tr -d ' \n' | grep -qi 'ffd8' \
    || { echo "SMOKE FAIL: file->file produced something that is not a JPEG" >&2; exit 1; }

  # Стрим-режим (png:- -> jpg:-) НЕ используется в коде: на боевом образе он
  # молча отдавал 0 байт с exit 0 (0.3.3-0.3.5). Проверяем справочно, чтобы
  # в манифесте было видно, изменилось ли это в новой сборке.
  if "$IM" png:- -resize '64x64>' -quality 30 jpg:- < "$T/s.png" > "$T/stream.jpg" 2>/dev/null; then
    if [ -s "$T/stream.jpg" ]; then STREAM=ok; else STREAM=broken-empty-exit0; fi
  else
    STREAM=broken-nonzero-exit
  fi

  # Тот же стрим, но stdin — ПАЙП, а не файл. Именно эта форма (adb exec-out |
  # magick png:- ... jpg:-) молча отдавала 0 байт в 0.3.3-0.3.5, тогда как
  # вариант с файлом на stdin выше отрабатывает нормально.
  if cat "$T/s.png" | "$IM" png:- -resize '64x64>' -quality 30 jpg:- > "$T/piped.jpg" 2>/dev/null; then
    if [ -s "$T/piped.jpg" ]; then PIPED=ok; else PIPED=broken-empty-exit0; fi
  else
    PIPED=broken-nonzero-exit
  fi
}

# 1.3.0 (§2 спеки, ревизия 17.09): геометрия и mean/sd скриншота гоняются
# через ФУНКЦИИ /ui.js (buildImagePipeline, parseGeometry) — не через свою
# копию команды IM. Копия проверяла бы дубликат, а не код adb_screenshot.
# xc:black должен разобраться как тёмный кадр 1080x2340 -> 473x1024,
# gradient: — как обычный (не тёмный).
geometry_check() {
  T2=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$T'; rm -rf '$T2'" EXIT

  "$IM" -size 1080x2340 xc:black "$T2/black.png"
  "$IM" -size 1080x2340 gradient: "$T2/grad.png"

  for name in black grad; do
    CMD=$(node -e "
      const ui = require('/ui.js');
      process.stdout.write(ui.buildImagePipeline('$T2/$name.png', '$T2/$name.jpg', 1024, 70));
    ") || { echo "SMOKE FAIL: buildImagePipeline failed in node ($name)" >&2; exit 1; }
    IM="$IM" sh -c "$CMD" 2>"$T2/$name.geom" \
      || { echo "SMOKE FAIL: screenshot-geometry pipeline ($name, im=$IM) exit $?" >&2; cat "$T2/$name.geom" >&2; exit 1; }
  done

  node -e "
    const fs = require('fs');
    const ui = require('/ui.js');
    const black = ui.parseGeometry(fs.readFileSync('$T2/black.geom', 'utf8'));
    const grad = ui.parseGeometry(fs.readFileSync('$T2/grad.geom', 'utf8'));
    if (!(black.W === 1080 && black.H === 2340 && black.w === 473 && black.h === 1024)) {
      console.error('SMOKE FAIL: geometry mismatch for xc:black: ' + JSON.stringify(black)); process.exit(1);
    }
    if (black.dark !== true) {
      console.error('SMOKE FAIL: xc:black not detected as dark: ' + JSON.stringify(black)); process.exit(1);
    }
    if (grad.dark !== false) {
      console.error('SMOKE FAIL: gradient: falsely detected as dark: ' + JSON.stringify(grad)); process.exit(1);
    }
  " || exit 1

  GEOM_STATUS=ok
}

collect
case "${1:-runtime}" in
  build)
    guard
    modules_guard
    smoke
    geometry_check
    {
      echo "built: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      echo "nodejs: $NODE_V"
      echo "android-tools(adb): $ADB_V"
      echo "imagemagick: $IM_V (bin: $IM)"
      echo "modules: ok ($TOOL_COUNT tools registered)"
      echo "screenshot-pipeline(file->file): ok"
      echo "imagemagick-stream(stdin=file): $STREAM"
      echo "imagemagick-stream(stdin=pipe): $PIPED"
      echo "screenshot-geometry: $GEOM_STATUS"
    } > "$MANIFEST"
    echo "Toolchain OK -> $(tr '\n' '; ' < "$MANIFEST")"
    ;;
  runtime)
    echo "node $NODE_V | adb $ADB_V | ImageMagick $IM_V ($IM)"
    ;;
  *)
    echo "usage: $0 build|runtime" >&2; exit 2
    ;;
esac
