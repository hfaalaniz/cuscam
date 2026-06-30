# 🍓 cuscam en Raspberry Pi (Linux)

Guía para correr cuscam de forma nativa en una Raspberry Pi (Debian/Raspberry Pi
OS, ARM64) como servidor 24/7. El código es multiplataforma: el mismo repo corre
en Windows (`start-all.ps1`) y en Linux (`start-all.sh` / systemd).

## Requisitos

- Raspberry Pi (3/4/5) con Raspberry Pi OS 64-bit.
- `git` y `ffmpeg` (vienen en Raspberry Pi OS; si no: `sudo apt install -y git ffmpeg`).
- Node.js 18+ (LTS).

## 1. Node.js

```bash
# Node LTS vía NodeSource (recomendado en Raspberry Pi OS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

## 2. Clonar el proyecto

```bash
cd ~
git clone https://github.com/hfaalaniz/cuscam.git
cd cuscam
```

## 3. MediaMTX (binario ARM64)

Descarga el release de Linux ARM64 y descomprímelo en `mediamtx/`:

```bash
cd ~/cuscam
mkdir -p mediamtx && cd mediamtx
# Ajusta la versión a la última de https://github.com/bluenviron/mediamtx/releases
VER=v1.15.0
curl -fsSL -o mtx.tar.gz \
  "https://github.com/bluenviron/mediamtx/releases/download/${VER}/mediamtx_${VER}_linux_arm64.tar.gz"
tar xzf mtx.tar.gz && rm mtx.tar.gz
cd ~/cuscam
```

> El backend detecta automáticamente la carpeta `mediamtx/` (o cualquier
> `mediamtx_*`) y el binario correcto según el sistema operativo.

## 4. Configurar cámaras y dependencias

```bash
cd ~/cuscam
cp config/cameras.example.json config/cameras.json
nano config/cameras.json        # pon windowsHostIp = la IP de la Raspberry, y tus cámaras

cd backend && npm install && cd ..
cd desktop && npm install && npm run build && cd ..
```

## 5. Prueba manual

```bash
bash start-all.sh
# Abre http://<IP-de-la-raspberry>:3100
```

## 6. Arranque automático (systemd)

Copia y activa los servicios (revisa que las rutas/usuario en los `.service`
coincidan con tu instalación: por defecto `/home/fabian/cuscam` y usuario `fabian`):

```bash
sudo cp server/systemd/cuscam-mediamtx.service /etc/systemd/system/
sudo cp server/systemd/cuscam-backend.service  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cuscam-mediamtx cuscam-backend
sudo systemctl status cuscam-backend --no-pager
```

Para que el backend pueda reiniciar MediaMTX al cambiar la config de grabación
(servicio `cuscam-mediamtx`), permite al usuario gestionarlo sin sudo:

```bash
# Regla polkit: el usuario 'fabian' puede reiniciar SOLO ese servicio.
sudo tee /etc/polkit-1/rules.d/50-cuscam.rules >/dev/null <<'RULE'
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "cuscam-mediamtx.service" &&
      subject.user == "fabian") {
    return polkit.Result.YES;
  }
});
RULE
```

## Notas

- **IP estable:** dale a la Raspberry una reserva DHCP o IP estática (en el router
  o con NetworkManager) para que las cámaras y el acceso remoto no se rompan.
- **Acceso remoto:** ver Cloudflare Tunnel (`cam.electroplan.net`) en el README.
- **Logs:** `journalctl -u cuscam-backend -f` y `journalctl -u cuscam-mediamtx -f`.
