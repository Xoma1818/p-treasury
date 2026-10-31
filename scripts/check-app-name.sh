#!/usr/bin/env bash
# Имя программы и NSIS-хук не должны откатиться при слиянии (так случилось в 0.27.0).
# При намеренном переименовании поменять APP_NAME здесь.
set -euo pipefail
APP_NAME=Kazna
conf="$(dirname "$0")/../src-tauri/tauri.conf.json"
for f in productName mainBinaryName; do
  v="$(jq -r ".$f" "$conf")"
  [ "$v" = "$APP_NAME" ] || { echo "::error::В tauri.conf.json $f = $v, ожидается $APP_NAME"; exit 1; }
done
[ "$(jq -r '.bundle.windows.nsis.installerHooks // empty' "$conf")" = windows/hooks.nsh ] \
  || { echo "::error::В tauri.conf.json нет bundle.windows.nsis.installerHooks (удаление старой P-Treasury)"; exit 1; }
echo "Имя программы: $APP_NAME, хук NSIS на месте"
