# 🔒 Acceso desde internet con Tailscale (gratis, sin dominio)

Tailscale crea una red privada cifrada (VPN) entre tus dispositivos. Tu teléfono
verá tu PC con una IP fija privada (`100.x.x.x`) desde **cualquier red** (4G, Wi-Fi
ajena, etc.), sin abrir puertos del router ni necesitar dominio.

**Ventaja clave:** como cuscam sirve todo por un solo origen (`:3100`) con URLs
relativas, **WebRTC (tiempo casi real) también funciona por Tailscale**, no solo HLS.

---

## Paso 1 — Crear cuenta Tailscale (gratis)
Entra en https://tailscale.com y regístrate (con Google, GitHub, etc.).
El plan Personal es gratuito (hasta 100 dispositivos).

## Paso 2 — Instalar Tailscale en la PC (servidor)
1. Descarga el cliente de Windows: https://tailscale.com/download/windows
2. Instálalo e inicia sesión con tu cuenta.
3. Verás un icono de Tailscale en la bandeja. Tu PC ya está en la red.

Para ver la IP de Tailscale de tu PC:
```powershell
tailscale ip -4
```
Será algo como `100.101.102.103`. **Esa es la IP que usará el teléfono.**

## Paso 3 — Instalar Tailscale en el teléfono
1. Instala la app **Tailscale** desde Google Play.
2. Inicia sesión con **la misma cuenta**.
3. Activa la VPN (botón "Connect"). Listo: el teléfono ya ve tu PC.

## Paso 4 — Probar
Con cuscam corriendo en la PC (usa `start-all.ps1`), abre en el navegador del
teléfono (con Tailscale activo):
```
http://100.101.102.103:3100      <- usa la IP de tu PC del Paso 2
```
Deberías ver las cámaras desde cualquier red. WebRTC y HLS funcionan.

## Paso 5 — App Android
En `android/app/src/main/res/values/strings.xml`, pon:
```xml
<string name="cuscam_url">http://100.101.102.103:3100</string>
```
(con la IP Tailscale de tu PC) y compila la app (ver `android/README.md`).

La app funcionará en casa Y fuera de casa, mientras Tailscale esté activo en el
teléfono.

---

## Notas
- La IP `100.x.x.x` de tu PC en Tailscale **es fija** (no cambia), a diferencia de
  la IP pública de tu casa.
- No necesitas el firewall de `setup-firewall.ps1` para Tailscale (va por la VPN),
  pero no estorba dejarlo para acceso LAN directo.
- Seguridad: solo los dispositivos en TU cuenta Tailscale pueden acceder. Es
  privado por diseño.

## Arquitectura
```
Teléfono (4G / Wi-Fi externa, con Tailscale activo)
  → http://100.x.x.x:3100  (red privada cifrada Tailscale)
  → tu PC: backend :3100 (web + API + HLS + WebRTC, todo por un origen)
  → MediaMTX → cámaras
```
