# 📱 cuscam-mobile (React Native CLI)

App móvil para ver las cámaras V380 en cuadrícula vía HLS (puerto 8888 de MediaMTX).

`App.js` y `package.json` de esta carpeta son la lógica de la app. Como React Native CLI
necesita carpetas nativas (`android/`, `ios/`), debes **generar el proyecto base** una
sola vez y luego copiar/usar este `App.js`.

## 1. Generar el proyecto nativo (una sola vez)

Requisitos: Node 18+, JDK 17, Android Studio (SDK + un emulador o teléfono con depuración USB).

```bash
# Desde una carpeta temporal, crea el proyecto base
npx @react-native-community/cli@latest init CuscamMobile

# Entra al proyecto generado
cd CuscamMobile

# Instala el reproductor de video
npm install react-native-video
```

## 2. Usar el código de esta app

Copia el `App.js` de esta carpeta sobre el `App.js` (o `App.tsx`) del proyecto generado.
Edita la constante `WINDOWS_HOST_IP` para que apunte a la IP fija de tu PC Windows.

## 3. Permitir tráfico HTTP en claro (cleartext) — IMPORTANTE

El streaming HLS local va por `http://` (no `https`). Android 9+ bloquea esto por defecto.

### Android
En `android/app/src/main/AndroidManifest.xml`, dentro de la etiqueta `<application ...>` agrega:

```xml
<application
  ...
  android:usesCleartextTraffic="true">
```

> Más seguro: en lugar de habilitarlo globalmente, restringe el cleartext solo a la IP
> de tu host con un `network_security_config.xml`. Para uso doméstico, el flag de arriba
> es suficiente.

### iOS (si compilas para iPhone)
En `ios/CuscamMobile/Info.plist` agrega una excepción ATS:

```xml
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsArbitraryLoads</key>
  <true/>
</dict>
```

## 4. Correr la app

```bash
# Inicia el bundler
npm start

# En otra terminal, instala y lanza en Android
npm run android
```

El teléfono debe estar en la **misma red Wi‑Fi** que la PC servidor.
La app intenta primero leer la lista de cámaras desde el backend
(`http://WINDOWS_HOST_IP:3000/api/cameras`) y, si no responde, usa la lista local del `App.js`.
