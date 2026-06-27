#!/usr/bin/env node
/**
 * Genera server/mediamtx.yml a partir de config/cameras.json,
 * de modo que las rutas RTSP y los "id" sean la única fuente de verdad.
 *
 * Uso:  node server/generate-mediamtx-config.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "cameras.json");
const OUT_PATH = path.join(__dirname, "mediamtx.yml");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const { hlsPort, cameras } = config;

// Ruta RTSP efectiva según la calidad elegida (ch00_0 = alta, ch00_1 = baja).
function effectiveRtsp(cam) {
  const quality = cam.quality || "low";
  let rtsp = cam.rtsp;
  if (quality === "high") rtsp = rtsp.replace(/ch00_1(\b|$)/, "ch00_0$1");
  else rtsp = rtsp.replace(/ch00_0(\b|$)/, "ch00_1$1");
  return rtsp;
}

const paths = cameras
  .map(
    (cam) =>
      // rtspTransport: tcp -> muchas cámaras V380 no anuncian bien los puertos
      // UDP ("server ports have not been provided"); forzar TCP lo resuelve.
      `  ${cam.id}:\n` +
      `    source: ${effectiveRtsp(cam)}\n` +
      `    rtspTransport: tcp\n` +
      `    sourceOnDemand: no\n`
  )
  .join("\n");

const yml = `# ARCHIVO GENERADO por server/generate-mediamtx-config.mjs
# No editar a mano: cambia config/cameras.json y vuelve a ejecutar el generador.

# Logs a archivo para diagnóstico (mediamtx.log junto al binario).
logLevel: info
logDestinations: [stdout, file]
logFile: mediamtx.log

# API de control/estado (para consultar el estado de cada cámara).
api: yes
apiAddress: :9997

hls: yes
hlsAddress: :${hlsPort}
hlsVariant: lowLatency
hlsAlwaysRemux: yes
# Segmentos más cortos = menor latencia (a costa de algo más de CPU/red).
hlsSegmentCount: 7
hlsSegmentDuration: 200ms
hlsPartDuration: 200ms

# WebRTC: latencia casi en tiempo real (<1s). Listo para el reproductor WebRTC.
webrtc: yes
webrtcAddress: :8889
webrtcLocalUDPAddress: :8189
# Anuncia TODAS las IPs por las que se puede alcanzar la PC (LAN + Tailscale),
# para que los candidatos ICE funcionen tanto en casa como por internet.
webrtcAdditionalHosts: ${JSON.stringify(
  [config.windowsHostIp, ...(config.extraHosts || [])].filter(
    (h) => h && h !== "localhost"
  )
)}

rtsp: yes
rtspAddress: :8554

paths:
${paths}`;

fs.writeFileSync(OUT_PATH, yml, "utf-8");
console.log(`mediamtx.yml generado con ${cameras.length} cámara(s) -> ${OUT_PATH}`);
