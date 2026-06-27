# 📱 cuscam Android (WebView)

App Android que envuelve el frontend web de cuscam en un WebView. Reusa toda la
funcionalidad existente (grid, PTZ, HD/SD, modales, zoom, doble click) y reproduce
el video por HLS (que funciona tanto en LAN como por internet vía Cloudflare Tunnel).

## Estructura

Este es un proyecto de Android Studio listo para abrir. Lo importante:

- `app/src/main/java/com/cuscam/app/MainActivity.kt` — la Activity con el WebView.
- `app/src/main/res/values/strings.xml` — contiene **CUSCAM_URL**: la URL que carga la app.
- `app/src/main/AndroidManifest.xml` — permisos de internet y config de red.

## 1. Configurar la URL que abre la app

Edita `app/src/main/res/values/strings.xml` y pon en `cuscam_url`:

- **Para internet (Tailscale):** `http://100.x.x.x:3100` (la IP Tailscale de tu PC,
  ver `server/TAILSCALE-SETUP.md`). Funciona en casa y fuera de casa.
- **Solo para LAN (pruebas):** `http://192.168.1.39:3100`

> Con Tailscale, tanto WebRTC (tiempo casi real) como HLS funcionan por internet,
> porque cuscam sirve todo por un solo origen con URLs relativas.

## 2. Abrir y compilar en Android Studio

1. Abre Android Studio → **Open** → selecciona esta carpeta `android/`.
2. Espera a que Gradle sincronice.
3. Conecta tu teléfono (depuración USB) o usa un emulador.
4. Pulsa **Run ▶**.

Para generar el APK instalable:
**Build → Build Bundle(s) / APK(s) → Build APK(s)**. El APK queda en
`app/build/outputs/apk/debug/app-debug.apk`.

## 3. Notas

- La app permite contenido HTTP en claro (`usesCleartextTraffic`), necesario para
  acceder por IP (LAN o Tailscale `100.x.x.x`).
- El botón Atrás del teléfono navega hacia atrás en el WebView si hay historial.
- El WebView reproduce el video del frontend (WebRTC o HLS según el modo elegido);
  con Tailscale ambos funcionan también desde fuera de casa.
