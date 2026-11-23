#!/usr/bin/env bash
# Exercises Fleet's SSH askpass + key enrollment flow against either:
#   1. A disposable password-auth OpenSSH container (podman/docker), or
#   2. An ephemeral unprivileged local /usr/bin/sshd on 127.0.0.1 using an
#      SSH_ASKPASS-protected bootstrap key when podman/docker are unavailable.
set -euo pipefail

RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
elif [ -x /usr/bin/sshd ] || command -v sshd >/dev/null 2>&1; then
  RUNTIME="local-sshd"
else
  echo "Need podman, docker, or local sshd to run ephemeral SSH enrollment test." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/astranavi-askpass-test.XXXXXX")"
CID=""
SSHD_PID=""
cleanup() {
  if [ -n "$CID" ]; then
    "$RUNTIME" rm -f "$CID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SSHD_PID" ]; then
    kill "$SSHD_PID" >/dev/null 2>&1 || true
    wait "$SSHD_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
PASS="astranavi-test-pass"
LET_IN='umask 077; mkdir -p "$HOME/.ssh" || exit 1; f="$HOME/.ssh/authorized_keys"; k=$(printf %s "$1" | base64 -d) || exit 97; if [ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l)" -eq 0 ]; then echo >> "$f"; fi; if grep -qxF "$k" "$f" 2>/dev/null; then exit 0; fi; echo "$k" >> "$f"'

ssh-keygen -t ed25519 -N "" -f "$TMP_DIR/id_ed25519" -C "astra-navi@test" >/dev/null
PUB_B64="$(tr -d '\n' < "$TMP_DIR/id_ed25519.pub" | base64 | tr -d '[:space:]')"

ASKPASS="$TMP_DIR/askpass.sh"
cat > "$ASKPASS" <<EOF
#!/bin/sh
printf '%s\n' '${PASS}'
EOF
chmod 700 "$ASKPASS"

if [ "$RUNTIME" = "local-sshd" ]; then
  SSHD_BIN="$(command -v sshd || echo /usr/bin/sshd)"
  USER_NAME="$(id -un)"
  ssh-keygen -t ed25519 -N "" -f "$TMP_DIR/ssh_host_ed25519_key" >/dev/null
  ssh-keygen -t ed25519 -N "$PASS" -f "$TMP_DIR/bootstrap_ed25519" -C "bootstrap@test" >/dev/null
  cp "$TMP_DIR/bootstrap_ed25519.pub" "$TMP_DIR/authorized_keys"
  chmod 600 "$TMP_DIR/authorized_keys"

  cat > "$TMP_DIR/sshd_config" <<EOF
Port ${PORT}
ListenAddress 127.0.0.1
HostKey ${TMP_DIR}/ssh_host_ed25519_key
AuthorizedKeysFile ${TMP_DIR}/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
StrictModes no
PidFile ${TMP_DIR}/sshd.pid
Subsystem sftp internal-sftp
EOF

  "$SSHD_BIN" -D -e -f "$TMP_DIR/sshd_config" >"$TMP_DIR/sshd.log" 2>&1 &
  SSHD_PID=$!

  for _ in $(seq 1 30); do
    if ssh-keyscan -p "$PORT" 127.0.0.1 > "$TMP_DIR/known_hosts" 2>/dev/null && [ -s "$TMP_DIR/known_hosts" ]; then
      break
    fi
    sleep 0.1
  done
  [ -s "$TMP_DIR/known_hosts" ] || { echo "local sshd did not become ready" >&2; cat "$TMP_DIR/sshd.log" >&2 || true; exit 1; }

  LOCAL_LET_IN='f="$1"; shift; k=$(printf %s "$1" | base64 -d) || exit 97; if grep -qxF "$k" "$f" 2>/dev/null; then exit 0; fi; echo "$k" >> "$f"'
  env SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
    ssh -F /dev/null -p "$PORT" \
    -i "$TMP_DIR/bootstrap_ed25519" \
    -o IdentitiesOnly=yes \
    -o UserKnownHostsFile="$TMP_DIR/known_hosts" \
    -o StrictHostKeyChecking=yes \
    "${USER_NAME}@127.0.0.1" \
    sh -c "'$LOCAL_LET_IN'" _ "$TMP_DIR/authorized_keys" "$PUB_B64"

  OUT="$(ssh -F /dev/null -p "$PORT" \
    -i "$TMP_DIR/id_ed25519" \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o UserKnownHostsFile="$TMP_DIR/known_hosts" \
    -o StrictHostKeyChecking=yes \
    "${USER_NAME}@127.0.0.1" printf 'fleet-sshd-ok')"
  [ "$OUT" = "fleet-sshd-ok" ] || { echo "Unexpected ssh output: $OUT" >&2; exit 1; }
  echo "OK: SSH_ASKPASS enrolled key into local ephemeral sshd (${PORT}) and key-auth succeeded."
  exit 0
fi

CID="$("$RUNTIME" run -d --rm -p "127.0.0.1:${PORT}:22" \
  docker.io/library/alpine:3.20 \
  sh -c "apk add --no-cache openssh-server >/dev/null && \
    ssh-keygen -A >/dev/null && \
    adduser -D -s /bin/sh aichan && \
    printf 'aichan:%s\n' '${PASS}' | chpasswd && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/;s/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    mkdir -p /home/aichan/.ssh && chmod 700 /home/aichan/.ssh && chown -R aichan:aichan /home/aichan && \
    exec /usr/sbin/sshd -D -e")"

for _ in $(seq 1 30); do
  if ssh-keyscan -p "$PORT" 127.0.0.1 > "$TMP_DIR/known_hosts" 2>/dev/null && [ -s "$TMP_DIR/known_hosts" ]; then
    break
  fi
  sleep 0.25
done
[ -s "$TMP_DIR/known_hosts" ] || { echo "sshd container did not become ready" >&2; exit 1; }

env SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh -p "$PORT" \
  -o BatchMode=no \
  -o UserKnownHostsFile="$TMP_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  -o PubkeyAuthentication=no \
  -o NumberOfPasswordPrompts=1 \
  "aichan@127.0.0.1" \
  sh -c "'$LET_IN'" _ "$PUB_B64"

ssh -p "$PORT" \
  -i "$TMP_DIR/id_ed25519" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o UserKnownHostsFile="$TMP_DIR/known_hosts" \
  -o StrictHostKeyChecking=yes \
  "aichan@127.0.0.1" true

echo "OK: password-prompt askpass enrolled key into container sshd and key-auth succeeded."
