# =====================================================================
#  cuscam - Arranque / reinicio de todo el stack
# =====================================================================
#  Regenera la config de MediaMTX, reinicia MediaMTX y el backend.
#  Si ya estaban corriendo, los detiene y los vuelve a lanzar (reinicio).
#
#  Uso (NO requiere Administrador):
#     powershell -ExecutionPolicy Bypass -File "C:\Users\Fabian\cuscam\start-all.ps1"
#  o click derecho -> "Ejecutar con PowerShell".
# =====================================================================

$ErrorActionPreference = "Stop"

# --- Rutas ---
$Root        = Split-Path -Parent $MyInvocation.MyCommand.Path
$MediaMtxDir = Join-Path $Root "mediamtx_v1.19.1_windows_amd64"
$MediaMtxExe = Join-Path $MediaMtxDir "mediamtx.exe"
$BackendDir  = Join-Path $Root "backend"
$Generator   = Join-Path $Root "server\generate-mediamtx-config.mjs"
$GeneratedYml = Join-Path $Root "server\mediamtx.yml"
$TargetYml   = Join-Path $MediaMtxDir "mediamtx.yml"
$BackendPort = 3100

Write-Host "==> cuscam: arranque/reinicio del stack" -ForegroundColor Cyan

# ---------------------------------------------------------------------
# 1. Regenerar la config de MediaMTX desde config/cameras.json
# ---------------------------------------------------------------------
Write-Host "`n[1/4] Regenerando mediamtx.yml desde la configuracion..."
Push-Location $Root
node $Generator
Pop-Location
Copy-Item $GeneratedYml $TargetYml -Force
Write-Host "      Config copiada a $TargetYml"

# ---------------------------------------------------------------------
# 2. Reiniciar MediaMTX
# ---------------------------------------------------------------------
Write-Host "`n[2/4] Reiniciando MediaMTX..."
$mtx = Get-Process mediamtx -ErrorAction SilentlyContinue
if ($mtx) { $mtx | Stop-Process -Force; Write-Host "      MediaMTX anterior detenido." }
Start-Sleep -Seconds 1
Start-Process -FilePath $MediaMtxExe -WorkingDirectory $MediaMtxDir -WindowStyle Hidden
Write-Host "      MediaMTX iniciado."

# ---------------------------------------------------------------------
# 3. Reiniciar el backend (Node en el puerto $BackendPort)
# ---------------------------------------------------------------------
Write-Host "`n[3/4] Reiniciando el backend (puerto $BackendPort)..."
$listener = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $listener | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Write-Host "      Backend anterior detenido."
}
Start-Sleep -Seconds 1
$env:PORT = $BackendPort
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $BackendDir -WindowStyle Hidden
Write-Host "      Backend iniciado."

# ---------------------------------------------------------------------
# 4. Verificacion
# ---------------------------------------------------------------------
Write-Host "`n[4/4] Verificando servicios..."
Start-Sleep -Seconds 4

function Test-Service($name, $url) {
    try {
        $code = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode
        Write-Host ("      OK  {0,-12} {1}" -f $name, $url) -ForegroundColor Green
    } catch {
        Write-Host ("      ERR {0,-12} {1}" -f $name, $url) -ForegroundColor Red
    }
}

Test-Service "Backend"  "http://localhost:$BackendPort/api/health"
Test-Service "MediaMTX" "http://localhost:9997/v3/paths/list"

Write-Host "`n==> Listo. Abre la app en:" -ForegroundColor Cyan
Write-Host "      http://localhost:$BackendPort   (esta PC)"
Write-Host "      http://192.168.1.39:$BackendPort   (telefono / red)"
