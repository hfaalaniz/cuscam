# 🚀 cuscam — Guía de puesta en marcha

Sistema de monitoreo de cámaras V380 con:

- **server/** — MediaMTX en WSL (RTSP → HLS) + scripts de setup.
- **backend/** — API Node/Express que sirve la config de cámaras y el frontend web.
- **desktop/** — Frontend web React + Vite (ver cámaras en el navegador de la PC).
- **mobile/** — App React Native CLI (ver cámaras en el teléfono).
- **config/cameras.json** — Fuente única de verdad: IP del host y cámaras.

---

## Paso 0 — Configura tus cámaras

`config/cameras.json` **no está versionado** (contiene credenciales reales y
está en `.gitignore`). Tras clonar el repo, créalo a partir del ejemplo:

```bash
cp config/cameras.example.json config/cameras.json
```

Luego edítalo:

- `windowsHostIp`: IP fija de tu PC Windows.
- `cameras[].id`: identificador corto (usado en la URL HLS y en MediaMTX).
- `cameras[].rtsp`: URL RTSP real de cada cámara V380.
- `recording`: parámetros de grabación continua (ver [Grabación](#grabación-247)).

---

## Paso 1 — Servidor de streaming (WSL + MediaMTX)

```bash
# 1. Genera mediamtx.yml desde la config (en Windows o WSL, con Node):
cd server
node generate-mediamtx-config.mjs

# 2. Dentro de la terminal de Ubuntu/WSL, instala MediaMTX:
bash setup-wsl.sh

# 3. Arranca el servidor de streaming:
cd ~/mediamtx && ./mediamtx
```

Luego, en **PowerShell como Administrador**, reenvía los puertos de WSL a la red:

```powershell
cd server
powershell -ExecutionPolicy Bypass -File .\setup-windows-portforward.ps1
```

---

## Paso 2 — Backend (API + web)

```bash
cd backend
npm install
npm start          # http://localhost:3000/api/cameras
```

---

## Paso 3 — Frontend de escritorio (web)

```bash
cd desktop
npm install
npm run dev        # http://localhost:5173 (desarrollo, con proxy al backend)
```

Para producción, compílalo y el backend lo servirá automáticamente:

```bash
cd desktop && npm run build
# Ahora http://localhost:3000 muestra la web compilada.
```

---

## Paso 4 — App móvil

Sigue [`mobile/README.md`](mobile/README.md) (init de React Native CLI, copiar `App.js`,
habilitar cleartext HTTP, `npm run android`).

---

## Grabación 24/7

MediaMTX graba cada cámara en disco de forma continua, en segmentos. Los
parámetros viven en el bloque `recording` de `config/cameras.json`:

| Campo | Significado | Por defecto |
|---|---|---|
| `enabled` | Activa/desactiva la grabación global | `true` |
| `dir` | Carpeta de salida (relativa a la raíz del proyecto) | `recordings` |
| `retentionHours` | Borra automáticamente lo más antiguo de N horas | `720` (30 días) |
| `segmentDuration` | Duración de cada archivo (`15m`, `30m`, `1h`…) | `15m` |
| `format` | `fmp4` (robusto ante cortes) o `mp4` | `fmp4` |

También se puede ajustar todo desde el botón **⏺ Grabación** de la web (panel
que regenera la config y reinicia MediaMTX). Las grabaciones se guardan en
`recordings/<id-cámara>/` y **no se versionan** (`.gitignore`).

Para **ver y exportar** desde la web: botón **⏺** en cada cámara → modal con
línea de tiempo tipo DVR (reproducción continua encadenando segmentos). Arrastra
sobre la barra para seleccionar un rango y pulsa **⬇ Exportar clip MP4**.

### FFmpeg (necesario solo para exportar clips)

La exportación de clips MP4 usa FFmpeg, que **no se versiona** (`tools/` está en
`.gitignore`). Descárgalo una vez en la carpeta `tools/`:

```powershell
# Windows (build estático oficial):
$dest = "tools"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" `
  -OutFile "$env:TEMP\ffmpeg.zip"
Expand-Archive -Path "$env:TEMP\ffmpeg.zip" -DestinationPath $dest -Force
```

El backend localiza `ffmpeg.exe` automáticamente dentro de `tools/` (en cualquier
subcarpeta) o, si no, en el `PATH` del sistema. La grabación y la reproducción
funcionan sin FFmpeg; solo la exportación de clips lo requiere.

---

## Flujo de datos

```
Cámaras V380 --RTSP--> MediaMTX (WSL) --HLS:8888--> { desktop (web) , mobile (RN) }
                                  ^
config/cameras.json --> backend /api/cameras --> lista de URLs HLS para los clientes
```

## Seguridad (red doméstica)

- Asigna IP estática / reserva DHCP a cámaras y a la PC servidor.
- **No** expongas el puerto 8888 a internet. Para acceso remoto usa **Tailscale**
  o **WireGuard** (red privada cifrada).
