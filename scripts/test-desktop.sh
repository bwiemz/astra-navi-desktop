#!/usr/bin/env bash
# Runs a command inside a private, invisible desktop: a second KWin with its own session
# bus, accessibility bus and home folder. Programs started in it open their windows
# there, so her hands, her eyes and the whole app can be tried on real programs without
# anything appearing on the screen of whoever is using the PC.
#
#   scripts/test-desktop.sh bash -c 'kcalc & sleep 3; npm run chat -- "press 7 in the calculator"'
#
# Inside it: AI_CHAN_KWIN_LOG is set so window queries read this window manager's own
# log, and AI_CHAN_NO_VIRTUAL_INPUT=1 is set because a virtual pointer or keyboard is a
# real device: its clicks and keys would land on the real desktop, not in here. Controls
# pressed through accessibility do stay in here. NEST_W and NEST_H set the screen size.
set -euo pipefail

work="${AI_CHAN_TEST_DESKTOP_DIR:-$(mktemp -d)}"
# Sockets have a short path limit, so the runtime folder cannot live under a long temp path.
run="/run/user/$(id -u)/aichan-test-desktop"
mkdir -p "${run}" "${work}/home"
chmod 700 "${run}"

export HOME="${work}/home" XDG_RUNTIME_DIR="${run}"
export XDG_CONFIG_HOME="${HOME}/.config" XDG_DATA_HOME="${HOME}/.local/share" XDG_CACHE_HOME="${HOME}/.cache"
unset WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS
export QT_QPA_PLATFORM=wayland QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export NEST_LOG="${work}/log" AI_CHAN_KWIN_LOG="${work}/log.kwin" AI_CHAN_NO_VIRTUAL_INPUT=1
export NEST_W="${NEST_W:-1280}" NEST_H="${NEST_H:-800}"

# shellcheck disable=SC2016  # the inner script is meant to be expanded by the inner shell
exec dbus-run-session -- bash -c '
  # The accessibility bus is started by hand: the usual launcher needs systemd on the session bus.
  exec 9< <(dbus-daemon --config-file=/usr/share/defaults/at-spi2/accessibility.conf --nofork --print-address 2>"${NEST_LOG}.a11y")
  read -r AT_SPI_BUS_ADDRESS <&9
  export AT_SPI_BUS_ADDRESS
  /usr/lib/at-spi2-registryd >"${NEST_LOG}.registry" 2>&1 &
  registry=$!
  # Compositing stays on (KWin crashes on window activation without it), and its log goes
  # to a file instead of the journal so nothing from in here lands in the user'"'"'s log.
  QT_LOGGING_TO_CONSOLE=1 kwin_wayland --virtual --no-lockscreen --no-global-shortcuts \
    --socket wl-aichan-test --width "${NEST_W}" --height "${NEST_H}" >"${AI_CHAN_KWIN_LOG}" 2>&1 &
  kwin=$!
  for _ in $(seq 1 50); do [[ -S "${XDG_RUNTIME_DIR}/wl-aichan-test" ]] && break; sleep 0.1; done
  sleep 1.5 # the socket appears before the window manager is ready to answer on it
  export WAYLAND_DISPLAY=wl-aichan-test
  "$@"
  code=$?
  kill "${kwin}" "${registry}" 2>/dev/null
  wait "${kwin}" 2>/dev/null
  pkill -P $$ dbus-daemon 2>/dev/null
  exit "${code}"
' test-desktop "$@" 2>"${work}/log.bus"
