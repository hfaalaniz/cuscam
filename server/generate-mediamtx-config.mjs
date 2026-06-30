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

// Config de grabación (con valores por defecto si falta el bloque).
const rec = {
  enabled: true,
  dir: "recordings",
  retentionHours: 720, // 30 días
  segmentDuration: "1h",
  format: "fmp4",
  ...(config.recording || {}),
};

// Carpeta de grabaciones en la raíz del proyecto (ruta absoluta para MediaMTX).
// MediaMTX crea una subcarpeta por cámara usando %path.
const RECORD_ROOT = path.resolve(ROOT, rec.dir);

/**
 * Localiza ffmpeg.exe (buscando recursivamente en tools/, donde se descomprime
 * el build) para que runOnInit no dependa de que FFmpeg esté en el PATH.
 * Devuelve la ruta absoluta o "ffmpeg" como último recurso.
 */
function findFfmpeg() {
  const stack = [path.join(ROOT, "tools")];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^ffmpeg(\.exe)?$/i.test(e.name)) return full;
    }
  }
  return "ffmpeg";
}
// Usamos "/" en la ruta: MediaMTX interpreta "\" como escape en runOnInit y
// destruiría la ruta de Windows ("C:\Users..." -> "C:Users..."). Windows
// acepta "/" como separador igual. Si hay espacios, la entrecomillamos.
const FFMPEG_RAW = findFfmpeg().replace(/\\/g, "/");
const FFMPEG = /\s/.test(FFMPEG_RAW) ? `"${FFMPEG_RAW}"` : FFMPEG_RAW;

/** ¿Esta cámara debe grabar? Global salvo override `record` por cámara. */
function shouldRecord(cam) {
  if (!rec.enabled) return false;
  return cam.record !== false; // por defecto sigue al global
}

/** Bloque YAML de grabación para un path (vacío si no graba). */
function recordYaml(cam) {
  if (!shouldRecord(cam)) return "";
  // recordPath: una subcarpeta por cámara + timestamp del segmento.
  // %f en MediaMTX = microsegundos (evita colisiones de nombre).
  const recordPath = path
    .join(RECORD_ROOT, "%path", "%Y-%m-%d_%H-%M-%S-%f")
    .replace(/\\/g, "/"); // YAML/MediaMTX prefiere separadores "/"
  return (
    `    record: yes\n` +
    `    recordPath: ${recordPath}\n` +
    `    recordFormat: ${rec.format}\n` +
    `    recordSegmentDuration: ${rec.segmentDuration}\n` +
    `    recordDeleteAfter: ${rec.retentionHours}h\n`
  );
}

// Ruta RTSP efectiva según la calidad elegida. Reconoce los patrones de
// main/sub-stream de varias marcas:
//   · V380:      ch00_0 (alta) / ch00_1 (baja)
//   · Hikvision: /Streaming/Channels/101 (alta) / 102 (baja)
//   · Dahua:     subtype=0 (alta) / subtype=1 (baja)
// Para una cámara remota grabada por túnel, elegir la baja ("low") reduce
// mucho el ancho de banda subido.
function effectiveRtsp(cam) {
  const quality = cam.quality || "low";
  let rtsp = cam.rtsp || "";
  if (quality === "high") {
    rtsp = rtsp
      .replace(/ch00_1(\b|$)/, "ch00_0$1")
      .replace(/(\/Streaming\/Channels\/)\d0?2\b/i, "$1101")
      .replace(/subtype=1\b/i, "subtype=0");
  } else {
    rtsp = rtsp
      .replace(/ch00_0(\b|$)/, "ch00_1$1")
      .replace(/(\/Streaming\/Channels\/)\d0?1\b/i, "$1102")
      .replace(/subtype=0\b/i, "subtype=1");
  }
  return rtsp;
}

/** ¿Es una webcam USB (dispositivo DirectShow local), no una cámara IP RTSP? */
function isUsb(cam) {
  return cam.source === "usb";
}

/**
 * Bloque YAML para una webcam USB. MediaMTX no captura DirectShow por sí mismo,
 * así que lanzamos FFmpeg (runOnInit) que toma el dispositivo `dshow`, lo
 * codifica a H.264 y lo publica como RTSP local en la propia ruta. A partir de
 * ahí el resto del sistema (HLS, WebRTC, grabación) la trata igual que las V380.
 */
function usbYaml(cam) {
  // `device`: nombre amigable ("iSlim 321R") o el "Alternative name" PNP.
  // El PNP es más robusto (no choca si hay varias cámaras del mismo modelo).
  const device = String(cam.device || cam.name).replace(/"/g, '\\"');
  const fps = cam.fps || 25;
  const size = cam.size || "640x480";

  // Bitrate según la RESOLUCIÓN (no fijo): el anterior 1500k dejaba el 720p
  // borroso. ~4 bits/píxel (referencia a 25 fps) con ajuste suave por fps.
  // Da ≈2.8 Mbps a 720p@15 y ≈4 a 720p@30; ≈1.2 a 480p. Acotado a [1.2, 6]
  // Mbps. Se puede forzar por cámara con `bitrateKbps` en cameras.json.
  const [w, h] = size.split("x").map(Number);
  const autoKbps = Math.round((w * h * 4.0 * Math.sqrt(fps / 25)) / 1000);
  const bitrateKbps = cam.bitrateKbps || Math.max(1200, Math.min(6000, autoKbps));
  // FFmpeg: dshow -> H.264 (ultrafast, baja latencia) -> RTSP local TCP.
  // %RTSP_PORT es expandido por MediaMTX (8554 por defecto).
  //
  // NO forzamos -framerate en la ENTRADA dshow: exige una combinación exacta
  // resolución+fps que la cámara soporte, y si no coincide FFmpeg aborta con
  // "Could not set video options / I/O error" (p.ej. una HP que a 720p solo da
  // 30 fps fallaba al pedir 15). Dejamos que dshow capture a su tasa nativa y
  // normalizamos solo la SALIDA a `fps` constante. Además:
  //  · -use_wallclock_as_timestamps 1: timestamps por reloj real de llegada
  //    (las webcams baratas dan tasa irregular) -> evita el "drift" que
  //    reiniciaba la grabación y tumbaba el proceso.
  //  · -fflags +genpts: regenera PTS si faltan.
  //  · -vsync cfr -r <fps>: salida a tasa constante (duplica/descarta frames)
  //    -> H.264 estable para HLS y grabación.
  // preset veryfast (no ultrafast): bastante mejor calidad/eficiencia a 720p
  // sin dejar de ir en tiempo real. maxrate+bufsize estabilizan el bitrate.
  const ffmpeg =
    `${FFMPEG} -f dshow -rtbufsize 100M -use_wallclock_as_timestamps 1 ` +
    `-video_size ${size} ` +
    `-i video="${device}" ` +
    `-fflags +genpts -vsync cfr -r ${fps} ` +
    `-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p ` +
    `-g ${fps * 2} -b:v ${bitrateKbps}k -maxrate ${bitrateKbps}k ` +
    `-bufsize ${bitrateKbps * 2}k ` +
    `-f rtsp -rtsp_transport tcp rtsp://localhost:$RTSP_PORT/${cam.id}`;
  return (
    `  ${cam.id}:\n` +
    `    source: publisher\n` +
    `    runOnInit: ${ffmpeg}\n` +
    `    runOnInitRestart: yes\n` +
    recordYaml(cam)
  );
}

const paths = cameras
  .map((cam) =>
    isUsb(cam)
      ? usbYaml(cam)
      : // rtspTransport: tcp -> muchas cámaras V380 no anuncian bien los puertos
        // UDP ("server ports have not been provided"); forzar TCP lo resuelve.
        `  ${cam.id}:\n` +
        `    source: ${effectiveRtsp(cam)}\n` +
        `    rtspTransport: tcp\n` +
        `    sourceOnDemand: no\n` +
        recordYaml(cam)
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
