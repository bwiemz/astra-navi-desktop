#!/usr/bin/env bash
# Starts Astra Navi Desktop. This is what the application-menu entry runs.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${app_dir}"

# A desktop that was itself started from an Electron program can leave this set, which
# would make the app start as a plain script instead of a window.
unset ELECTRON_RUN_AS_NODE

# Started from the application menu or at login, the search path can be shorter than in a
# terminal. These are the usual homes of a Node.js that was not installed system-wide.
export PATH="${PATH}:${HOME}/.local/bin:/usr/local/bin"

electron="${app_dir}/node_modules/electron/dist/electron"
if [[ ! -x "${electron}" ]]; then
  message="Astra Navi Desktop is not set up yet. Open a terminal in ${app_dir} and run: npm install"
  command -v notify-send >/dev/null 2>&1 && notify-send "Astra Navi Desktop" "${message}"
  echo "${message}" >&2
  exit 1
fi

# Build once, the first time, or again after the source has been updated.
if [[ ! -f "${app_dir}/out/main/index.js" ]] || [[ -n "$(find "${app_dir}/src" -newer "${app_dir}/out/main/index.js" -print -quit)" ]]; then
  if ! "${app_dir}/node_modules/.bin/electron-vite" build; then
    message="Astra Navi Desktop could not be built. Open a terminal in ${app_dir} and run: npm run build"
    command -v notify-send >/dev/null 2>&1 && notify-send "Astra Navi Desktop" "${message}"
    echo "${message}" >&2
    # An older build is still better than nothing.
    [[ -f "${app_dir}/out/main/index.js" ]] || exit 1
  fi
fi

# The program itself is started directly, so showing her needs no Node.js on the search path.
exec "${electron}" "${app_dir}" "$@"
