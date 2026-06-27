# Reenvía los puertos de WSL hacia la red local de Windows para que el
# teléfono y otros dispositivos puedan ver los streams HLS de MediaMTX.
#
# EJECUTAR EN POWERSHELL COMO ADMINISTRADOR:
#   powershell -ExecutionPolicy Bypass -File .\setup-windows-portforward.ps1
#
# Nota: la IP de WSL cambia al reiniciar; vuelve a ejecutar este script si
# pierdes la conexión tras un reinicio.

$ErrorActionPreference = "Stop"

# Puertos a reenviar: 8888 = HLS (MediaMTX), 3000 = backend API (opcional).
$ports = @(8888, 3000)

# Obtiene la IP interna de WSL.
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
if (-not $wslIp) {
    Write-Error "No se pudo obtener la IP de WSL. ¿Está WSL en ejecución?"
    exit 1
}
Write-Host "IP de WSL detectada: $wslIp"

foreach ($port in $ports) {
    Write-Host "Configurando reenvío del puerto $port -> $wslIp:$port"

    # Elimina regla previa (si existe) y crea la nueva.
    netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>$null
    netsh interface portproxy add v4tov4 `
        listenport=$port listenaddress=0.0.0.0 `
        connectport=$port connectaddress=$wslIp

    # Abre el puerto en el Firewall de Windows.
    $ruleName = "cuscam-port-$port"
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound `
        -Action Allow -Protocol TCP -LocalPort $port | Out-Null
}

Write-Host ""
Write-Host "Reglas activas de portproxy:"
netsh interface portproxy show v4tov4

Write-Host ""
Write-Host "Listo. Tus dispositivos en la red pueden acceder vía la IP de esta PC."
