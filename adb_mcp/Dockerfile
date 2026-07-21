# ---------------------------------------------------------------------------
# Базовый образ.
# build.yaml объявлен Supervisor'ом устаревшим — WARNING печатается в КАЖДОЙ
# сборке ("uses build.yaml which is deprecated"), а с Supervisor 2026.04.0
# аргумент BUILD_FROM больше не подставляется по умолчанию. Когда поддержку
# build.yaml уберут, `FROM ${BUILD_FROM}` окажется пустым и сборка развалится
# у всех, кто ставит аддон. Поэтому база задаётся здесь, а build.yaml удалён.
#
# База — arch-less мультиарх-манифест, БЕЗ подстановки ${BUILD_ARCH}:
# дефолт арки был бы тихим неверным ответом (на ARM молча собралась бы
# amd64-база — issue #1 в ha-filesystem-mcp был ровно про кривую базу на
# aarch64). Arch-less манифест buildx резолвит сам по --platform, ошибиться
# негде. Одновременно это переезд 3.21 → 3.22: 3.21 вне окна поддержки
# docker-base (актуальные arch-less теги: 3.22, 3.23, 3.24). Смена базы меняет
# тулчейн (imagemagick 7.1.1 → 7.1.2) — осознанно проходит через guard и
# смоук в toolchain-check.sh.
# Если Supervisor передаст BUILD_FROM (старые версии) — тот переопределит
# дефолт, это штатно.
# ---------------------------------------------------------------------------
ARG BUILD_FROM=ghcr.io/home-assistant/base:3.22
FROM ${BUILD_FROM}

# Единый источник правды по версии: config.yaml -> BUILD_VERSION -> сюда ->
# server.js (process.env.ADDON_VERSION). До 0.3.9 версия дублировалась в
# server.js вручную, и 0.3.7/0.3.8 уехали в прод, представляясь v0.3.6.
ARG BUILD_VERSION=0.0.0-dev
ENV ADDON_VERSION=${BUILD_VERSION}

# ---------------------------------------------------------------------------
# Тулчейн.
# Жёстко пинить `pkg=версия-rN` нельзя: Alpine удаляет из ветки старые версии,
# и такой пин ломает установку у ВСЕХ при первом же security-патче
# (gitlab.alpinelinux.org/alpine/abuild#9996). Поэтому пакеты плавают внутри
# ветки, но сборка ПАДАЕТ, если ушёл мажор или если конвейер скриншота
# перестал работать — см. toolchain-check.sh.
# Нужна полная воспроизводимость — передай точные версии build-аргументами:
#   --build-arg IMAGEMAGICK_PKG="imagemagick=7.1.2.15-r0"
# Состояние Alpine 3.22-stable на 2026-07-21 (сверено по aports APKBUILD):
#   nodejs 22.23.0-r0, android-tools 35.0.2-r16, imagemagick 7.1.2.15-r0
# ⚠ IM 7.1.2 — тот же минор, что был на Alpine edge во время инцидента
# 0.3.3-0.3.5. Нам не мешает: код использует только файловый конвейер
# (file->file), а поведение стрим-режима фиксируют справочные пробы в
# манифесте сборки. К форме `adb exec-out | magick` НЕ возвращаться.
# ---------------------------------------------------------------------------
ARG NODEJS_PKG="nodejs"
ARG ANDROID_TOOLS_PKG="android-tools"
ARG IMAGEMAGICK_PKG="imagemagick"

# imagemagick-jpeg ставится ЯВНО: в Alpine кодеки вынесены в сабпакеты и
# подтягиваются эвристикой install_if (по наличию libjpeg-turbo в образе).
# Полагаться на эвристику нельзя — без этого пакета adb_screenshot не сможет
# записать JPEG.
RUN apk add --no-cache \
      "${NODEJS_PKG}" \
      "${ANDROID_TOOLS_PKG}" \
      "${IMAGEMAGICK_PKG}" \
      imagemagick-jpeg

COPY run.sh /run.sh
COPY toolchain-check.sh /toolchain-check.sh
COPY proxy.js /proxy.js
COPY server.js /server.js
RUN chmod a+x /run.sh /toolchain-check.sh \
    && /toolchain-check.sh build

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="amd64|aarch64"

CMD [ "/run.sh" ]
