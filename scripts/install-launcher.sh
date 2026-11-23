#!/usr/bin/env bash
# Adds Astra Navi Desktop to the application menu, so she can be started like any other
# program. Run again after moving the project folder. `--remove` takes it out again.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
entry="${data_home}/applications/astra-navi-desktop.desktop"
icon="${data_home}/icons/hicolor/256x256/apps/astra-navi-desktop.png"
legacy_entry="${data_home}/applications/ai-chan-desktop.desktop"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "${entry}" "${icon}" "${legacy_entry}" "${XDG_CONFIG_HOME:-${HOME}/.config}/autostart/astra-navi-desktop.desktop" "${XDG_CONFIG_HOME:-${HOME}/.config}/autostart/ai-chan-desktop.desktop"
  echo "Removed Astra Navi Desktop from the application menu."
  exit 0
fi

rm -f "${legacy_entry}"
mkdir -p "$(dirname "${entry}")" "$(dirname "${icon}")"
cp "${app_dir}/assets/icon.png" "${icon}"

# The path is quoted because the folder name may contain spaces, and the characters a
# desktop entry treats specially inside quotes are escaped.
exec_path="${app_dir}/scripts/launch.sh"
exec_path="${exec_path//\\/\\\\}"
exec_path="${exec_path//\"/\\\"}"
exec_path="${exec_path//\`/\\\`}"
exec_path="${exec_path//\$/\\\$}"
exec_path="${exec_path//%/%%}"

cat > "${entry}" <<EOF
[Desktop Entry]
Type=Application
Name=Astra Navi Desktop
GenericName=Local AI Navigator
Comment=Local-first AI desktop companion with 3D MMD avatar.
Exec="${exec_path}"
Icon=astra-navi-desktop
Terminal=false
Categories=Utility;
StartupWMClass=astra-navi-desktop
StartupNotify=false
EOF
chmod 644 "${entry}"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "${entry}")" >/dev/null 2>&1 || true

echo "Added. Look for \"Astra Navi Desktop\" in your application menu."
