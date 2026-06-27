# 🚀 cuscam — Guía de puesta en marcha

Sistema de monitoreo de cámaras V380 con:

- **server/** — MediaMTX en WSL (RTSP → HLS) + scripts de setup.
- **backend/** — API Node/Express que sirve la config de cámaras y el frontend web.
- **desktop/** — Frontend web React + Vite (ver cámaras en el navegador de la PC).
- **mobile/** — App React Native CLI (ver cámaras en el teléfono).
- **config/cameras.json** — Fuente única de verdad: IP del host y cámaras.

---

## Paso 0 — Configura tus cámaras

Edita [`config/cameras.json`](config/cameras.json):

- `windowsHostIp`: IP fija de tu PC Windows.
- `cameras[].id`: identificador corto (usado en la URL HLS y en MediaMTX).
- `cameras[].rtsp`: URL RTSP real de cada cámara V380.

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
