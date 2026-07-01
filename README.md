# 🎥 cuscam — Centro de Monitoreo de Cámaras

Sistema de videovigilancia para cámaras **IP RTSP/ONVIF** (V380, **Hikvision**,
Dahua, genéricas…) y **webcams USB**, con visualización en tiempo real desde el
navegador (escritorio), una app Android, y acceso seguro desde internet. Convierte
el vídeo a **WebRTC** (latencia <1s) y **HLS** (~1-2s) mediante MediaMTX, e incluye
**descubrimiento automático** de cámaras (escaneo de red local o remota), control
**PTZ** (movimiento), cambio de resolución **HD/SD** y más.

> Reescrito desde la idea original (React Native + WSL) a una arquitectura web
> servida por un backend Node sobre Windows nativo. Ver historial de cambios.

---

## ✨ Funcionalidades

- **Grid multi-cámara** en vivo (tema oscuro, responsivo).
- **Dos modos de transmisión** conmutables: **WebRTC** (tiempo casi real) y
  **HLS** (estable), con *fallback* automático de WebRTC a HLS.
- **Control PTZ** por ONVIF (mover la cámara: ▲◀▶▼) y **zoom digital** (＋/−).
- **Control por teclado** sobre la ventana activa: **flechas** = PAN/TILT,
  **TAB** = cambiar de cámara, **Ctrl + rueda** = zoom (también en la ampliada).
- **Cambio de calidad HD/SD** en caliente (720p ⇄ 360p) sin cortar las demás.
- **Reconexión automática**: si una cámara corta el stream, el reproductor se
  reengancha solo (con un indicador del nº de reconexiones por cámara).
- **Grabación continua 24/7** con retención configurable, **línea de tiempo tipo
  DVR** (con miniaturas al pasar el ratón) y **exportación de clips MP4** por rango.
- **Audio en vivo** vinculado a la ventana activa (exclusivo; por WebRTC).
- **Ventanas flotantes arrastrables** para todos los paneles/modales.
- **Doble click** en una cámara para verla **ampliada** en un modal.
- **Gestión de cámaras** desde la web: agregar, editar todas sus propiedades,
  credenciales RTSP, Wi-Fi (referencia), y ver **capacidades ONVIF** reales.
- **App Android** (WebView) que reusa toda la interfaz web.
- **Acceso remoto seguro** desde internet vía **Tailscale** (sin abrir puertos).

---

## 🏗️ Arquitectura

```mermaid
graph TD
    Cam1[Cámara V380 #1] -->|RTSP :554| MTX[MediaMTX en Windows]
    Cam2[Cámara V380 #2] -->|RTSP :554| MTX
    MTX -->|HLS :8888 / WebRTC :8889| BE[Backend Node :3100]
    BE -->|sirve web + API + proxy video| Web[Frontend Web React]
    BE --> Android[App Android WebView]
    BE -.->|PTZ ONVIF :8899| Cam1
    Tailscale[Tailscale VPN] -.->|acceso remoto| BE
```

**Clave del diseño:** el backend (`:3100`) sirve **todo por un solo origen** — la
web, la API y el video (proxeando HLS y WebRTC de MediaMTX). Las URLs son
relativas, así la misma app funciona en `localhost`, en la LAN, y por la IP de
Tailscale sin cambios.

### Componentes

| Carpeta | Qué es |
|---|---|
| [`backend/`](backend/) | API Node/Express: cámaras, PTZ ONVIF, calidad HD/SD, capacidades, proxy HLS/WebRTC. |
| [`desktop/`](desktop/) | Frontend web (React + Vite + hls.js). Toda la UI. |
| [`server/`](server/) | MediaMTX, generador de config, scripts (firewall, arranque) y guía Tailscale. |
| [`android/`](android/) | App Android (WebView) lista para Android Studio. |
| [`config/`](config/) | `cameras.json` (fuente única de verdad). **No versionado** — ver `cameras.example.json`. |
| [`mobile/`](mobile/) | App React Native CLI inicial (alternativa histórica). |

---

## 🚀 Puesta en marcha

### Requisitos
- **Windows** con [Node.js 18+](https://nodejs.org).
- [MediaMTX](https://github.com/bluenviron/mediamtx/releases) para Windows
  (descomprimido en `mediamtx_v1.19.1_windows_amd64/`).
- Cámaras V380 con **RTSP/ONVIF activado** (desde la app oficial V380).
- *(Opcional)* [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) en `tools/` — solo
  necesario para **exportar clips MP4**. Ver [`SETUP.md`](SETUP.md#ffmpeg-necesario-solo-para-exportar-clips).

### 1. Configurar las cámaras
Copia el ejemplo y edítalo con tus datos reales:
```bash
cp config/cameras.example.json config/cameras.json
```
Campos: `windowsHostIp`, `hlsPort`/`webrtcPort`, y por cámara `id`, `name`,
`rtsp` (con usuario/contraseña), `onvifPort`, `quality`.

### 2. Instalar dependencias y compilar el frontend
```bash
cd backend && npm install && cd ..
cd desktop && npm install && npm run build && cd ..
```

### 3. Arrancar todo
```powershell
# Regenera la config de MediaMTX, arranca MediaMTX y el backend, y verifica.
powershell -ExecutionPolicy Bypass -File .\start-all.ps1
```
Abre **http://localhost:3100**.

> Para que arranque solo al iniciar sesión en Windows, hay una **tarea
> programada** (`cuscam-autostart`). Si la borraste, vuelve a crearla apuntando
> a `start-all.ps1`.

---

## 🌐 Acceso desde internet (Tailscale)

Permite ver las cámaras desde cualquier red (datos móviles, otra ciudad) de forma
cifrada y **sin abrir puertos del router**. Guía completa:
[`server/TAILSCALE-SETUP.md`](server/TAILSCALE-SETUP.md).

Resumen: instala Tailscale en la PC y en el teléfono (misma cuenta), obtén la IP
`100.x.x.x` de la PC (`tailscale ip -4`), y accede a `http://100.x.x.x:3100`.
Tanto WebRTC como HLS funcionan por Tailscale.

---

## 🛰️ Cámaras en otra red / otra ubicación física

El servidor (el que graba 24/7) puede integrar cámaras IP que están en **otra red
física** (p. ej. cámaras Hikvision en otra casa/oficina), grabándolas de forma
centralizada. La clave: el servidor debe **poder alcanzar esas cámaras por red**.

### 1. Conectar las dos redes (Tailscale subnet router)
En el sitio remoto pon un dispositivo pequeño **siempre encendido** (una Raspberry
Pi, o un router compatible con Tailscale) que anuncie la red de las cámaras:
```bash
# En el dispositivo del sitio remoto (ajusta el rango real de esa red):
tailscale up --advertise-routes=192.168.50.0/24
```
Aprueba esa ruta en el panel de Tailscale (https://login.tailscale.com → Machines →
la máquina → *Edit route settings*). En el **servidor cuscam**:
```bash
tailscale up --accept-routes
```
Ahora el servidor ve las cámaras remotas (`192.168.50.x`) como si fueran locales.

### 2. Descubrir y añadir las cámaras
En la web, **🔍 Descubrir cámaras** → pestaña *Cámaras IP*:
- En **«Subred a escanear»** escribe los 3 primeros octetos de la red remota
  (p. ej. `192.168.50`) y pulsa **Escanear**.
- Elige la cámara: el sistema sondea rutas y credenciales (incluye las de
  **Hikvision** `/Streaming/Channels/101`, **Dahua**, V380, ONVIF…). Las
  Hikvision piden usuario/contraseña (normalmente `admin` + la que configuraste).

### 3. Ahorrar ancho de banda (sub-stream)
Grabar cámaras remotas en alta 24/7 consume mucha subida (~40 GB/día por cámara a
1080p). Usa el botón **HD/SD** de la tarjeta para grabar el **sub-stream (SD)**:
cuscam reconoce el patrón de cada marca y cambia a la pista de baja resolución
(Hikvision `…/102`, Dahua `subtype=1`, V380 `ch00_1`). El alta calidad puede
quedar en la SD/NVR de la propia cámara como respaldo.

---

## 📱 App Android

Proyecto WebView listo para compilar en Android Studio. Solo configura la URL
(`cuscam_url` en `android/app/src/main/res/values/strings.xml`) con tu IP de
Tailscale o LAN, y compila. Detalles: [`android/README.md`](android/README.md).

---

## 🔧 Acceso para LAN local (opcional)

Para ver desde otros dispositivos en tu red local sin Tailscale, abre los puertos
en el Firewall de Windows (requiere Administrador):
```powershell
powershell -ExecutionPolicy Bypass -File .\server\setup-firewall.ps1
```

---

## 🔒 Seguridad

- **Nunca** expongas los puertos de las cámaras (554/8888) directo a internet.
  Usa Tailscale (recomendado) o un túnel con autenticación.
- Asigna **IP estática / reserva DHCP** a cámaras y a la PC servidor.
- `config/cameras.json` y `server/mediamtx.yml` contienen credenciales y están
  **excluidos del repositorio** (`.gitignore`). No los subas.

### Login propio (opcional)

El backend puede exigir usuario y contraseña para toda la web, la API y el vídeo.
Se activa **solo** si defines las variables de entorno; si no, funciona sin login
(útil en LAN de confianza). La sesión es una cookie firmada (HMAC-SHA256), sin
estado en el servidor.

| Variable | Descripción |
|----------|-------------|
| `CUSCAM_USER` | Usuario. Activa el login junto con la contraseña. |
| `CUSCAM_PASSWORD` | Contraseña en texto (se hashea al vuelo). |
| `CUSCAM_PASSWORD_HASH` | Alternativa: sha256 hex, para no dejar la clave en el env. |
| `CUSCAM_SECRET` | Clave para firmar cookies. Si no se define, se genera una aleatoria en cada arranque (las sesiones se invalidan al reiniciar). |
| `CUSCAM_SESSION_HOURS` | Duración de la sesión (por defecto 720 = 30 días). |
| `CUSCAM_LOGIN_MAX_ATTEMPTS` | Intentos fallidos por IP antes de bloquear (por defecto 8). |
| `CUSCAM_LOGIN_LOCKOUT_MS` | Duración del bloqueo por fuerza bruta en ms (por defecto 900000 = 15 min). |

Tras `CUSCAM_LOGIN_MAX_ATTEMPTS` fallos seguidos, esa IP recibe **429** durante el
tiempo de bloqueo (protección contra fuerza bruta). Un login correcto reinicia el
contador. Si la sesión caduca mientras usas la app, el frontend detecta el 401 y
vuelve automáticamente a la pantalla de login.

---

## 🧩 Referencia rápida de la API (backend `:3100`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/cameras` | Lista de cámaras con URLs de video. |
| POST | `/api/cameras` | Agregar cámara (IP RTSP o `source:"usb"`). |
| GET | `/api/discover/network` | Escanea la red buscando cámaras (`?subnet=192.168.50` para otra red). |
| POST | `/api/discover/probe` | Sondea una IP (rutas+credenciales RTSP) y valida el stream. |
| GET | `/api/usb-cameras/scan` | Lista webcams USB (DirectShow) con sus formatos. |
| GET | `/api/cameras/:id/recording-days` | Días con grabación (para el selector de fechas). |
| PUT | `/api/cameras/:id` | Editar todas las propiedades. |
| DELETE | `/api/cameras/:id` | Eliminar cámara. |
| PATCH | `/api/cameras/:id/credentials` | Actualizar usuario/clave RTSP. |
| PATCH | `/api/cameras/:id/wifi` | Guardar Wi-Fi de referencia. |
| GET | `/api/cameras/:id/full` | Propiedades con RTSP desglosado. |
| GET | `/api/cameras/:id/capabilities` | Capacidades ONVIF reales. |
| POST | `/api/cameras/:id/ptz` | Comando PTZ (mover/detener). |
| POST | `/api/cameras/:id/quality` | Cambiar HD/SD en caliente. |
| GET/PUT | `/api/recording/config` | Config de grabación (guardar reinicia MediaMTX). |
| GET | `/api/cameras/:id/recordings` | Lista de segmentos grabados. |
| GET | `/api/cameras/:id/timeline` | Línea de tiempo (segmentos con hora real). |
| GET | `/api/cameras/:id/recordings/:file` | Sirve un segmento (con Range / `?download=1`). |
| GET | `/api/cameras/:id/export` | Exporta un clip MP4 de `?from=&to=` (requiere FFmpeg). |
| GET | `/api/cameras/:id/frame` | Fotograma de previsualización en `?at=` (miniatura del timeline). |
| GET | `/api/cameras/:id/signal-events` | Historial de pérdidas/recuperaciones de señal (del log MediaMTX). |
| GET/PUT | `/api/network` | Config de red (host, puertos). |
| — | `/hls/*`, `/whep/*` | Proxy a MediaMTX (HLS y WebRTC). |
