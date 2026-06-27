# Abre en el Firewall de Windows los puertos que cuscam usa, para acceder
# a las cámaras desde otros dispositivos de la red (teléfono, otra PC).
#
# EJECUTAR COMO ADMINISTRADOR. Dos formas:
#   1) Click derecho en este archivo -> "Ejecutar con PowerShell" (si pide admin, acepta).
#   2) Abre PowerShell como Administrador y ejecuta:
#        powershell -ExecutionPolicy Bypass -File "C:\Users\Fabian\cuscam\server\setup-firewall.ps1"

# Si no se está ejecutando como admin, se relanza pidiendo elevación.
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Solicitando permisos de Administrador..."
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$rules = @(
    @{ Name = "cuscam HLS 8888 TCP";        Port = 8888; Proto = "TCP" },
    @{ Name = "cuscam WebRTC 8889 TCP";     Port = 8889; Proto = "TCP" },
    @{ Name = "cuscam WebRTC ICE 8189 UDP"; Port = 8189; Proto = "UDP" },
    @{ Name = "cuscam RTSP 8554 TCP";       Port = 8554; Proto = "TCP" },
    @{ Name = "cuscam Backend 3100 TCP";    Port = 3100; Proto = "TCP" }
)

foreach ($r in $rules) {
    Remove-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
        -Protocol $r.Proto -LocalPort $r.Port -Profile Private,Domain | Out-Null
    Write-Host "Abierto: $($r.Name)  ($($r.Proto)/$($r.Port))"
}

Write-Host ""
Write-Host "Listo. Reglas de firewall creadas para la red privada."
Write-Host "Presiona una tecla para cerrar..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
