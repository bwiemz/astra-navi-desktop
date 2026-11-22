#!/usr/bin/env bash
# Exercises Fleet's password-prompt SSH key enrollment flow against a disposable
# password-enabled OpenSSH server container (using podman or docker).
set -euo pipefail

RUNTIME=""
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "Need podman or docker to spin up an ephemeral password-auth sshd container." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aichan-askpass-test.XXXXXX")"
CID=""
cleanup() {
  if [ -n "$CID" ]; then
    "$RUNTIME" rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
PASS="aichan-test-pass"

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

ssh-keygen -t ed25519 -N "" -f "$TMP_DIR/id_ed25519" -C "ai-chan@test" >/dev/null
PUB_B64="$(tr -d '\n' < "$TMP_DIR/id_ed25519.pub" | base64 | tr -d '[:space:]')"

ASKPASS="$TMP_DIR/askpass.sh"
cat > "$ASKPASS" <<EOF
#!/bin/sh
printf '%s\n' '${PASS}'
EOF
chmod 700 "$ASKPASS"

LET_IN='umask 077; mkdir -p "$HOME/.ssh" || exit 1; f="$HOME/.ssh/authorized_keys"; k=$(printf %s "$1" | base64 -d) || exit 97; if [ -s "$f" ] && [ "$(tail -c 1 "$f" | wc -l)" -eq 0 ]; then echo >> "$f"; fi; if grep -qxF "$k" "$f" 2>/dev/null; then exit 0; fi; echo "$k" >> "$f"'

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
