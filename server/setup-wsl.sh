#!/usr/bin/env bash
#
# Setup de MediaMTX dentro de WSL/Ubuntu para cuscam.
# Descarga el binario, instala la config y deja todo listo para arrancar.
#
# Uso (desde la terminal de Ubuntu/WSL, en la carpeta server/ del proyecto):
#   bash setup-wsl.sh
#
set -euo pipefail

MEDIAMTX_VERSION="v1.9.3"
ARCH="linux_amd64"
TARBALL="mediamtx_${MEDIAMTX_VERSION}_${ARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/${TARBALL}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/mediamtx"

echo "==> Actualizando repositorios del sistema..."
sudo apt update -y

echo "==> Asegurando dependencias (wget, tar)..."
sudo apt install -y wget tar

echo "==> Preparando carpeta de instalación: ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

if [ ! -f "./mediamtx" ]; then
  echo "==> Descargando MediaMTX ${MEDIAMTX_VERSION}..."
  wget -q --show-progress "${DOWNLOAD_URL}" -O "${TARBALL}"
  echo "==> Descomprimiendo..."
  tar -xf "${TARBALL}"
  rm -f "${TARBALL}"
else
  echo "==> MediaMTX ya está instalado, omitiendo descarga."
fi

echo "==> Copiando configuración mediamtx.yml..."
if [ -f "${SCRIPT_DIR}/mediamtx.yml" ]; then
  cp "${SCRIPT_DIR}/mediamtx.yml" "${INSTALL_DIR}/mediamtx.yml"
else
  echo "ADVERTENCIA: no se encontró ${SCRIPT_DIR}/mediamtx.yml"
  echo "  Genera primero con: node generate-mediamtx-config.mjs"
fi

echo ""
echo "============================================================"
echo " Instalación completa."
echo " Para arrancar el servidor de streaming:"
echo "   cd ${INSTALL_DIR} && ./mediamtx"
echo ""
echo " Las URLs HLS de salida quedarán en:"
echo "   http://<IP-DE-TU-PC-WINDOWS>:8888/<id-camara>/index.m3u8"
echo "============================================================"
