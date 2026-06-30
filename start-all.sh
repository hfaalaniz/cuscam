#!/usr/bin/env bash
# =====================================================================
#  cuscam - Arranque / reinicio del stack en Linux (Raspberry Pi)
# =====================================================================
#  Equivalente de start-all.ps1 para Linux. Regenera mediamtx.yml,
#  (re)lanza MediaMTX y el backend Node, y verifica.
#
#  Uso:  bash start-all.sh
#  Para arranque automático al encender, usa el servicio systemd
#  (ver server/systemd/ o el README). Este script es para pruebas/manual.
# =====================================================================
set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${PORT:-3100}"

echo "==> cuscam: arranque/reinicio del stack (Linux)"

# --- Localizar la carpeta de MediaMTX (mediamtx/ o mediamtx_*) ---
MTX_DIR=""
if [ -x "$ROOT/mediamtx/mediamtx" ]; then
  MTX_DIR="$ROOT/mediamtx"
else
  for d in "$ROOT"/mediamtx_*; do
    if [ -x "$d/mediamtx" ]; then MTX_DIR="$d"; break; fi
  done
fi
if [ -z "$MTX_DIR" ]; then
  echo "ERROR: no se encontró el binario de MediaMTX (carpeta mediamtx/ o mediamtx_*/)." >&2
  exit 1
fi

echo "[1/4] Regenerando mediamtx.yml..."
node "$ROOT/server/generate-mediamtx-config.mjs"
cp "$ROOT/server/mediamtx.yml" "$MTX_DIR/mediamtx.yml"

echo "[2/4] Reiniciando MediaMTX..."
pkill -f "$MTX_DIR/mediamtx" 2>/dev/null || true
sleep 1
( cd "$MTX_DIR" && nohup ./mediamtx >/dev/null 2>&1 & )
echo "      MediaMTX iniciado."

echo "[3/4] Reiniciando el backend (puerto $BACKEND_PORT)..."
# Mata el backend anterior (node server.js de este proyecto).
pkill -f "$ROOT/backend/server.js" 2>/dev/null || true
sleep 1
( cd "$ROOT/backend" && PORT="$BACKEND_PORT" nohup node server.js >/dev/null 2>&1 & )
echo "      Backend iniciado."

echo "[4/4] Verificando servicios..."
sleep 4
check() {
  if curl -fsS --max-time 5 "$2" >/dev/null 2>&1; then
    echo "      OK  $1"
  else
    echo "      ERR $1 ($2)"
  fi
}
check "Backend " "http://localhost:$BACKEND_PORT/api/health"
check "MediaMTX" "http://localhost:9997/v3/paths/list"

echo ""
echo "==> Listo. Abre la app en:"
echo "      http://localhost:$BACKEND_PORT"
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] && echo "      http://$IP:$BACKEND_PORT   (red local)"
