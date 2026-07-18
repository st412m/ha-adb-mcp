#!/usr/bin/with-contenv bashio

TOKEN=$(bashio::config 'token')
export ADB_MCP_TOKEN="${TOKEN}"

LOG_REQUESTS=$(bashio::config 'log_requests' 2>/dev/null || echo "false")
export LOG_REQUESTS="${LOG_REQUESTS}"

ALLOW_SHELL=$(bashio::config 'allow_shell' 2>/dev/null || echo "true")
export ALLOW_SHELL="${ALLOW_SHELL}"

# Критично: ADB RSA-ключи должны переживать рестарты аддона, иначе
# устройство будет заново спрашивать "Allow USB debugging?" после каждого
# обновления. HOME=/data -> ключи в /data/.android/adbkey (persistent volume).
export HOME=/data
mkdir -p /data/.android

# adb-сервер слушает на всех интерфейсах: если в config.yaml проброшен порт
# 5037, интеграция androidtv может использовать этот же сервер через
# adb_server_ip и не воевать за прямое подключение к устройству.
export ADB_SERVER_SOCKET=tcp:0.0.0.0:5037

bashio::log.info "Starting adb server..."
adb start-server

# Автоподключение устройств из конфига (ip или ip:port)
for host in $(bashio::config 'devices' 2>/dev/null); do
    case "${host}" in
        *:*) target="${host}" ;;
        *)   target="${host}:5555" ;;
    esac
    bashio::log.info "adb connect ${target}"
    adb connect "${target}" || bashio::log.warning "Failed to connect ${target} (will retry via adb_connect tool)"
done

adb devices -l

bashio::log.info "Starting ADB MCP Server v0.1.0 on port 3199 (allow_shell: ${ALLOW_SHELL})"
node /server.js 3199 &

sleep 2

bashio::log.info "Starting auth proxy on port 3200 (request logging: ${LOG_REQUESTS})"
node /proxy.js
