#!/bin/sh
# Проверка тулчейна аддона. Запускается ДВАЖДЫ:
#   /toolchain-check.sh build    — на сборке образа: падает, если версии ушли
#                                  или если конвейер скриншота не работает
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
    echo "TOOLCHAIN GUARD: nodejs $NODE_V, ожидался мажор $EXPECT_NODE_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$IM_V")" != "$EXPECT_IM_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: ImageMagick $IM_V, ожидался мажор $EXPECT_IM_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$ADB_V")" != "$EXPECT_ADB_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: android-tools $ADB_V, ожидался мажор $EXPECT_ADB_MAJOR" >&2; rc=1
  fi
  if [ "$rc" != 0 ]; then
    echo "" >&2
    echo "Сборка остановлена: Alpine отдал не тот тулчейн, на котором аддон" >&2
    echo "проверен. Прогони adb_screenshot вручную, убедись что всё работает," >&2
    echo "и обнови EXPECT_*_MAJOR в toolchain-check.sh." >&2
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
  [ -s "$T/s.jpg" ] || { echo "SMOKE FAIL: file->file дал пустой JPEG" >&2; exit 1; }
  head -c 2 "$T/s.jpg" | od -An -tx1 | tr -d ' \n' | grep -qi 'ffd8' \
    || { echo "SMOKE FAIL: file->file дал не JPEG" >&2; exit 1; }

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

collect
case "${1:-runtime}" in
  build)
    guard
    smoke
    {
      echo "built: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      echo "nodejs: $NODE_V"
      echo "android-tools(adb): $ADB_V"
      echo "imagemagick: $IM_V (bin: $IM)"
      echo "screenshot-pipeline(file->file): ok"
      echo "imagemagick-stream(stdin=file): $STREAM"
      echo "imagemagick-stream(stdin=pipe): $PIPED"
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
