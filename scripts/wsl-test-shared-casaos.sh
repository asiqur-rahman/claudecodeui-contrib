#!/usr/bin/env bash
set -euo pipefail

APP_DATA=/tmp/cloudcli-shared-testdata2
NAME=cloudcli-shared-wsl-test
PORT=50082
IMAGE=asiqurrahman/cloudcli-ui:production

docker rm -f "$NAME" >/dev/null 2>&1 || true
mkdir -p "$APP_DATA"
chown -R 1000:1000 "$APP_DATA"
mkdir -p /home/asiq/.claude /home/asiq/.commandcode /home/asiq/.codex /home/asiq/.cursor /home/asiq/.local/bin /home/asiq/.local/share
touch /home/asiq/.claude.json || true

echo "== starting $NAME (with host Cursor agent mounts) =="
docker run -d --name "$NAME" \
  --user 1000:1000 \
  -p "${PORT}:3001" \
  -e PATH=/host-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$APP_DATA:/data" \
  -v /home/asiq/.claude:/data/.claude \
  -v /home/asiq/.claude.json:/data/.claude.json \
  -v /home/asiq/.commandcode:/data/.commandcode \
  -v /home/asiq/.codex:/data/.codex \
  -v /home/asiq/.cursor:/data/.cursor \
  -v /home/asiq/.local/bin:/host-bin \
  -v /home/asiq/.local/share:/home/asiq/.local/share \
  "$IMAGE"

echo "== waiting for health =="
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 90 ]; then
    echo "NOT healthy"
    docker logs "$NAME" 2>&1 | tail -60
    exit 1
  fi
  sleep 1
done

# Fresh DB may have been wiped if APP_DATA was new; register if needed
STATUS=$(curl -sS "http://127.0.0.1:${PORT}/api/auth/status")
echo "auth_status=$STATUS"
if echo "$STATUS" | grep -q '"needsSetup":true'; then
  curl -sS -X POST "http://127.0.0.1:${PORT}/api/auth/register" \
    -H 'Content-Type: application/json' \
    -d '{"username":"wsltest","password":"wsltest-pass-123"}' >/dev/null
fi

LOGIN=$(curl -sS -X POST "http://127.0.0.1:${PORT}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"wsltest","password":"wsltest-pass-123"}')
TOKEN=$(printf '%s' "$LOGIN" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("token") or "")')
echo "token_ok len=${#TOKEN}"

echo "== provider auth/status =="
FAIL=0
for p in claude codex command-code cursor opencode; do
  echo "--- $p ---"
  RESP=$(curl -sS "http://127.0.0.1:${PORT}/api/providers/${p}/auth/status" \
    -H "Authorization: Bearer $TOKEN")
  echo "$RESP"
  AUTH=$(printf '%s' "$RESP" | python3 -c 'import sys,json
d=json.load(sys.stdin); s=d.get("data") or d
print("true" if s.get("authenticated") is True else "false")')
  case "$p" in
    claude|codex|command-code)
      if [ "$AUTH" != "true" ]; then
        echo "EXPECTED authenticated=true for $p"
        FAIL=1
      fi
      ;;
  esac
done

echo "== agent binary inside container =="
docker exec "$NAME" bash -lc 'command -v agent; command -v cursor-agent; ls -la /host-bin/agent; agent status 2>&1 | head -30' || true

if [ "$FAIL" -ne 0 ]; then
  echo "== FAIL =="
  exit 2
fi
echo "== PASS host-credential providers; container left running on :${PORT} =="
echo "UI: http://127.0.0.1:${PORT}/  user=wsltest  pass=wsltest-pass-123"
