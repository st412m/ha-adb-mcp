ARG BUILD_FROM
FROM ${BUILD_FROM}

# ---------------------------------------------------------------------------
# Тулчейн.
# Базовый образ прибит к Alpine 3.21 в build.yaml, но ВНУТРИ ветки apk отдаёт
# текущую версию пакета — два ребилда в разное время дают разные сборки.
# Жёстко пинить `pkg=версия-rN` нельзя: Alpine удаляет из ветки старые версии,
# и такой пин ломает установку у ВСЕХ при первом же security-патче
# (gitlab.alpinelinux.org/alpine/abuild#9996). Поэтому пакеты плавают внутри
# 3.21, но сборка ПАДАЕТ, если ушёл мажор или если конвейер скриншота
# перестал работать — см. toolchain-check.sh.
# Нужна полная воспроизводимость — передай точные версии build-аргументами
# из build.yaml, например:
#   args:
#     IMAGEMAGICK_PKG: "imagemagick=7.1.1.41-r0"
# Состояние Alpine 3.21-stable на 2026-07-21:
#   nodejs 22.23.0-r0, android-tools 35.0.2-r7, imagemagick 7.1.1.41-r0
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

CMD [ "/run.sh" ]
