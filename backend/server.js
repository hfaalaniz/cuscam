import express from "express";
import cors from "cors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import onvif from "onvif";
import { createProxyMiddleware } from "http-proxy-middleware";

const { Cam } = onvif;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "cameras.json");
const DESKTOP_DIST = path.join(ROOT, "desktop", "dist");
const GENERATOR = path.join(ROOT, "server", "generate-mediamtx-config.mjs");
const GENERATED_YML = path.join(ROOT, "server", "mediamtx.yml");
const MEDIAMTX_DIR = path.join(ROOT, "mediamtx_v1.19.1_windows_amd64");
const MEDIAMTX_EXE = path.join(MEDIAMTX_DIR, "mediamtx.exe");
const MEDIAMTX_YML = path.join(MEDIAMTX_DIR, "mediamtx.yml");
const MEDIAMTX_LOG = path.join(MEDIAMTX_DIR, "mediamtx.log");
const TOOLS_DIR = path.join(ROOT, "tools");

/**
 * Localiza el ejecutable de FFmpeg: primero en tools/ (descargado junto al
 * proyecto, incluso dentro de subcarpetas del ZIP), luego en el PATH. Devuelve
 * la ruta o null si no se encuentra.
 */
function findFfmpeg() {
  // Búsqueda recursiva superficial dentro de tools/ por ffmpeg.exe.
  const stack = [TOOLS_DIR];
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
  return "ffmpeg"; // confía en el PATH como último recurso
}

// Valores por defecto de grabación (si falta el bloque en la config).
const RECORDING_DEFAULTS = {
  enabled: true,
  dir: "recordings",
  retentionHours: 720, // 30 días
  segmentDuration: "1h",
  format: "fmp4",
};

/** Devuelve la config de grabación combinada con los valores por defecto. */
function recordingConfig(config) {
  return { ...RECORDING_DEFAULTS, ...(config.recording || {}) };
}

/** Carpeta absoluta donde MediaMTX guarda las grabaciones. */
function recordingsDir(config) {
  return path.resolve(ROOT, recordingConfig(config).dir);
}

/**
 * Regenera mediamtx.yml desde la config y reinicia MediaMTX para aplicar los
 * cambios (MediaMTX no recarga la config de grabación en caliente). Provoca un
 * corte de ~2s en todas las cámaras. Devuelve { ok, error }.
 */
function regenerateAndRestartMediaMtx() {
  // 1. Regenerar el yml.
  const gen = spawnSync("node", [GENERATOR], { cwd: ROOT, encoding: "utf-8" });
  if (gen.status !== 0) {
    return { ok: false, error: "Fallo al generar mediamtx.yml: " + (gen.stderr || "") };
  }
  // 2. Copiarlo junto al binario.
  try {
    fs.copyFileSync(GENERATED_YML, MEDIAMTX_YML);
  } catch (err) {
    return { ok: false, error: "No se pudo copiar mediamtx.yml: " + err.message };
  }
  // 3. Reiniciar MediaMTX (matar el proceso y relanzarlo).
  try {
    spawnSync("taskkill", ["/IM", "mediamtx.exe", "/F"], { encoding: "utf-8" });
  } catch {
    /* puede no estar corriendo; no es fatal */
  }
  try {
    const child = spawn(MEDIAMTX_EXE, [], {
      cwd: MEDIAMTX_DIR,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, error: "No se pudo iniciar MediaMTX: " + err.message };
  }
  return { ok: true };
}

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Lee la configuración en cada request para que los cambios en
 * config/cameras.json se reflejen sin reiniciar el servidor.
 */
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw);
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Devuelve la URL RTSP efectiva de una cámara según su calidad seleccionada.
 * En V380, ch00_0 = main-stream (alta) y ch00_1 = sub-stream (baja).
 * Por defecto se mantiene la ruta tal cual está en la config.
 */
function effectiveRtsp(cam) {
  const quality = cam.quality || "low";
  let rtsp = cam.rtsp;
  if (quality === "high") {
    rtsp = rtsp.replace(/ch00_1(\b|$)/, "ch00_0$1");
  } else {
    rtsp = rtsp.replace(/ch00_0(\b|$)/, "ch00_1$1");
  }
  return rtsp;
}

/**
 * Construye la lista de cámaras con su URL HLS de salida apuntando
 * a MediaMTX (puerto HLS en la IP del host Windows).
 */
function buildCameras(config) {
  const { cameras } = config;
  return cameras.map((cam) => ({
    id: cam.id,
    name: cam.name,
    // URLs RELATIVAS: el backend proxea tanto HLS (/hls) como WebRTC (/whep).
    // Al ser relativas al host actual, funcionan automáticamente desde
    // localhost, la IP LAN (192.168.x), o la IP de Tailscale (100.x) sin
    // cambiar nada. WebRTC sigue siendo tiempo casi real también por Tailscale.
    url: `/hls/${cam.id}/index.m3u8`,
    webrtcUrl: `/whep/${cam.id}/whep`,
    deviceId: cam.deviceId,
    model: cam.model,
    quality: cam.quality || "low",
    // ¿Esta cámara está grabando? Global salvo override por cámara.
    recording: recordingConfig(config).enabled && cam.record !== false,
  }));
}

/** Normaliza un texto a un id seguro para rutas (a-z, 0-9, guiones). */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// API: lista de cámaras lista para consumir por desktop y móvil.
app.get("/api/cameras", (req, res) => {
  try {
    const config = loadConfig();
    res.json({ cameras: buildCameras(config) });
  } catch (err) {
    console.error("Error leyendo configuración:", err);
    res.status(500).json({ error: "No se pudo leer la configuración de cámaras" });
  }
});

// API: añadir una cámara nueva.
// Body: { name, ip, port?, path?, user?, password?, deviceId?, model? }
// o bien { name, rtsp } para pasar la URL completa.
app.post("/api/cameras", (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    // Construye la URL RTSP a partir de campos o usa la provista directamente.
    let rtsp = (body.rtsp || "").trim();
    if (!rtsp) {
      const ip = (body.ip || "").trim();
      if (!ip) {
        return res.status(400).json({ error: "Falta la IP o la URL RTSP" });
      }
      const port = body.port || 554;
      const streamPath = (body.path || "/live/ch00_1").replace(/^\/?/, "/");
      const creds =
        body.user && body.password
          ? `${encodeURIComponent(body.user)}:${encodeURIComponent(body.password)}@`
          : "";
      rtsp = `rtsp://${creds}${ip}:${port}${streamPath}`;
    }

    const config = loadConfig();

    // id: usa deviceId si viene, si no, slug del nombre. Garantiza unicidad.
    let id = body.deviceId ? `cam${slugify(body.deviceId)}` : slugify(name);
    if (!id) id = "cam";
    const existingIds = new Set(config.cameras.map((c) => c.id));
    let uniqueId = id;
    let n = 2;
    while (existingIds.has(uniqueId)) {
      uniqueId = `${id}-${n++}`;
    }

    const camera = { id: uniqueId, name, rtsp };
    if (body.deviceId) camera.deviceId = String(body.deviceId);
    if (body.model) camera.model = String(body.model);

    config.cameras.push(camera);
    saveConfig(config);

    res.status(201).json({ camera: buildCameras(config).find((c) => c.id === uniqueId) });
  } catch (err) {
    console.error("Error añadiendo cámara:", err);
    res.status(500).json({ error: "No se pudo añadir la cámara" });
  }
});

/** Desglosa una URL RTSP en sus partes: user, password, ip, port, path. */
function parseRtsp(rtsp) {
  const out = { user: "", password: "", ip: "", port: "554", path: "/live/ch00_1" };
  const m = String(rtsp || "").match(
    /^rtsp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+)(?::(\d+))?(\/.*)?$/i
  );
  if (!m) return out;
  out.user = m[1] ? decodeURIComponent(m[1]) : "";
  out.password = m[2] ? decodeURIComponent(m[2]) : "";
  out.ip = m[3] || "";
  out.port = m[4] || "554";
  out.path = m[5] || "/live/ch00_1";
  return out;
}

/** Reconstruye una URL RTSP a partir de sus partes. */
function buildRtsp({ user, password, ip, port, path: streamPath }) {
  const creds =
    user && password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : "";
  const p = (streamPath || "/live/ch00_1").replace(/^\/?/, "/");
  return `rtsp://${creds}${ip}:${port || 554}${p}`;
}

/** Reemplaza usuario:contraseña en una URL RTSP existente. */
function setRtspCredentials(rtsp, user, password) {
  // rtsp://[user:pass@]host:port/path  ->  inserta/actualiza credenciales
  const m = rtsp.match(/^(rtsp:\/\/)(?:[^@/]*@)?(.*)$/i);
  if (!m) return rtsp;
  const creds =
    user && password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : "";
  return `${m[1]}${creds}${m[2]}`;
}

// API: actualizar credenciales RTSP (usuario/contraseña) de una cámara.
// Body: { user, password }
app.patch("/api/cameras/:id/credentials", (req, res) => {
  try {
    const { user, password } = req.body || {};
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    cam.rtsp = setRtspCredentials(cam.rtsp, user, password);
    saveConfig(config);
    res.json({ camera: buildCameras(config).find((c) => c.id === cam.id) });
  } catch (err) {
    console.error("Error actualizando credenciales:", err);
    res.status(500).json({ error: "No se pudieron actualizar las credenciales" });
  }
});

// API: guardar el Wi-Fi de referencia de una cámara (SSID/clave).
// NOTA: esto NO reconfigura la cámara; solo guarda los datos como referencia.
// El cambio real de Wi-Fi se hace por la app oficial V380.
// Body: { ssid, password }
app.patch("/api/cameras/:id/wifi", (req, res) => {
  try {
    const { ssid, password } = req.body || {};
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    cam.wifi = {
      ssid: ssid ? String(ssid) : "",
      password: password ? String(password) : "",
    };
    saveConfig(config);
    res.json({ ok: true, wifi: { ssid: cam.wifi.ssid } });
  } catch (err) {
    console.error("Error guardando Wi-Fi:", err);
    res.status(500).json({ error: "No se pudo guardar el Wi-Fi" });
  }
});

// API: leer el Wi-Fi de referencia guardado de una cámara.
app.get("/api/cameras/:id/wifi", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });
    res.json({ wifi: cam.wifi || { ssid: "", password: "" } });
  } catch (err) {
    res.status(500).json({ error: "No se pudo leer el Wi-Fi" });
  }
});

// API: leer la configuración de red (IP del host, puerto HLS y WebRTC).
app.get("/api/network", (req, res) => {
  try {
    const config = loadConfig();
    res.json({
      windowsHostIp: config.windowsHostIp,
      hlsPort: config.hlsPort,
      webrtcPort: config.webrtcPort || 8889,
    });
  } catch (err) {
    res.status(500).json({ error: "No se pudo leer la configuración de red" });
  }
});

// API: actualizar la configuración de red.
// Body: { windowsHostIp, hlsPort, webrtcPort }
app.put("/api/network", (req, res) => {
  try {
    const { windowsHostIp, hlsPort, webrtcPort } = req.body || {};
    const config = loadConfig();
    if (windowsHostIp != null) config.windowsHostIp = String(windowsHostIp).trim();
    if (hlsPort != null) config.hlsPort = Number(hlsPort);
    if (webrtcPort != null) config.webrtcPort = Number(webrtcPort);
    saveConfig(config);
    res.json({
      windowsHostIp: config.windowsHostIp,
      hlsPort: config.hlsPort,
      webrtcPort: config.webrtcPort || 8889,
    });
  } catch (err) {
    console.error("Error actualizando red:", err);
    res.status(500).json({ error: "No se pudo actualizar la configuración de red" });
  }
});

// API: leer TODAS las propiedades editables de una cámara (RTSP desglosado).
app.get("/api/cameras/:id/full", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const parts = parseRtsp(cam.rtsp);
    res.json({
      camera: {
        id: cam.id,
        name: cam.name || "",
        deviceId: cam.deviceId || "",
        model: cam.model || "",
        ip: parts.ip,
        port: parts.port,
        path: parts.path,
        user: parts.user,
        password: parts.password,
        onvifPort: cam.onvifPort || 8899,
        wifi: cam.wifi || { ssid: "", password: "" },
      },
    });
  } catch (err) {
    console.error("Error leyendo cámara:", err);
    res.status(500).json({ error: "No se pudo leer la cámara" });
  }
});

// API: editar TODAS las propiedades de una cámara de una sola vez.
// Body: { name, deviceId, model, ip, port, path, user, password, wifi:{ssid,password} }
app.put("/api/cameras/:id", (req, res) => {
  try {
    const body = req.body || {};
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    if (body.name != null) {
      const name = String(body.name).trim();
      if (!name) return res.status(400).json({ error: "El nombre es obligatorio" });
      cam.name = name;
    }
    if (body.deviceId != null) cam.deviceId = String(body.deviceId);
    if (body.model != null) cam.model = String(body.model);
    if (body.onvifPort != null) {
      cam.onvifPort = Number(body.onvifPort) || 8899;
      ptzCams.delete(cam.id); // invalida la conexión ONVIF cacheada
    }

    // Reconstruye la URL RTSP a partir de los campos desglosados.
    if (body.ip != null || body.port != null || body.path != null ||
        body.user != null || body.password != null) {
      const current = parseRtsp(cam.rtsp);
      cam.rtsp = buildRtsp({
        ip: body.ip != null ? String(body.ip).trim() : current.ip,
        port: body.port != null ? body.port : current.port,
        path: body.path != null ? String(body.path) : current.path,
        user: body.user != null ? body.user : current.user,
        password: body.password != null ? body.password : current.password,
      });
    }

    if (body.wifi && typeof body.wifi === "object") {
      cam.wifi = {
        ssid: body.wifi.ssid ? String(body.wifi.ssid) : "",
        password: body.wifi.password ? String(body.wifi.password) : "",
      };
    }

    // Grabación on/off por cámara. Cambiarlo requiere reiniciar MediaMTX.
    let recordChanged = false;
    if (body.record != null) {
      const next = body.record !== false;
      if ((cam.record !== false) !== next) recordChanged = true;
      cam.record = next;
    }

    saveConfig(config);
    if (recordChanged) regenerateAndRestartMediaMtx();
    res.json({ camera: buildCameras(config).find((c) => c.id === cam.id) });
  } catch (err) {
    console.error("Error editando cámara:", err);
    res.status(500).json({ error: "No se pudo editar la cámara" });
  }
});

// --- PTZ vía ONVIF ---

// Cache de conexiones ONVIF por cámara (conectar es lento; lo reutilizamos).
const ptzCams = new Map();

/** Conecta (o reutiliza) la conexión ONVIF de una cámara. */
function getOnvifCam(cam) {
  if (ptzCams.has(cam.id)) return Promise.resolve(ptzCams.get(cam.id));

  const parts = parseRtsp(cam.rtsp);
  const onvifPort = cam.onvifPort || 8899; // V380 suele usar 8899 (o 80)

  return new Promise((resolve, reject) => {
    const device = new Cam(
      {
        hostname: parts.ip,
        username: parts.user,
        password: parts.password,
        port: onvifPort,
        timeout: 5000,
      },
      (err) => {
        if (err) return reject(err);
        ptzCams.set(cam.id, device);
        resolve(device);
      }
    );
  });
}

/** Mapea una dirección a vectores de velocidad pan/tilt/zoom. */
function ptzVector(direction, speed = 0.5) {
  const s = Math.max(0, Math.min(1, speed));
  switch (direction) {
    case "up": return { x: 0, y: s, zoom: 0 };
    case "down": return { x: 0, y: -s, zoom: 0 };
    case "left": return { x: -s, y: 0, zoom: 0 };
    case "right": return { x: s, y: 0, zoom: 0 };
    case "upleft": return { x: -s, y: s, zoom: 0 };
    case "upright": return { x: s, y: s, zoom: 0 };
    case "downleft": return { x: -s, y: -s, zoom: 0 };
    case "downright": return { x: s, y: -s, zoom: 0 };
    case "zoomin": return { x: 0, y: 0, zoom: s };
    case "zoomout": return { x: 0, y: 0, zoom: -s };
    default: return null;
  }
}

/** Envuelve un método ONVIF basado en callback en una promesa (o null si falla). */
function onvifCall(device, method, ...args) {
  return new Promise((resolve) => {
    try {
      device[method](...args, (err, result) => resolve(err ? null : result));
    } catch {
      resolve(null);
    }
  });
}

// API: consultar las capacidades reales de la cámara por ONVIF.
app.get("/api/cameras/:id/capabilities", async (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const device = await getOnvifCam(cam);

    // Consultas ONVIF en paralelo (cada una tolera fallo individual).
    const [info, nodes, profiles] = await Promise.all([
      onvifCall(device, "getDeviceInformation"),
      onvifCall(device, "getNodes"),
      onvifCall(device, "getProfiles"),
    ]);

    // Resumen PTZ a partir de los nodos.
    let ptz = { supported: false, pan: false, tilt: false, zoom: false };
    if (nodes) {
      const node = Object.values(nodes)[0];
      const sp = (node && node.supportedPTZSpaces) || {};
      ptz = {
        supported: !!node,
        pan: !!sp.continuousPanTiltVelocitySpace,
        tilt: !!sp.continuousPanTiltVelocitySpace,
        zoom: !!sp.continuousZoomVelocitySpace,
        nodeToken: node ? node.$ ? node.$.token : node.nodeToken : undefined,
      };
    }

    // Resumen de perfiles de video (resolución y códec).
    const videoProfiles = Array.isArray(profiles)
      ? profiles.map((p) => {
          const enc = p.videoEncoderConfiguration || {};
          const r = enc.resolution || {};
          return {
            name: p.name || p.$?.token,
            codec: enc.encoding,
            width: r.width,
            height: r.height,
            fps: enc.rateControl?.frameRateLimit,
            bitrate: enc.rateControl?.bitrateLimit,
          };
        })
      : [];

    res.json({
      device: info
        ? {
            manufacturer: info.manufacturer,
            model: info.model,
            firmware: info.firmwareVersion,
            serial: info.serialNumber,
            hardwareId: info.hardwareId,
          }
        : null,
      ptz,
      videoProfiles,
    });
  } catch (err) {
    console.error("Error capabilities:", err);
    ptzCams.delete(req.params.id);
    res.status(502).json({
      error:
        "No se pudo consultar la cámara por ONVIF. Verifica que ONVIF esté " +
        "activo y el puerto correcto. Detalle: " + err.message,
    });
  }
});

// Dirección de la API de control de MediaMTX (definida en mediamtx.yml).
const MEDIAMTX_API = process.env.MEDIAMTX_API || "http://localhost:9997";

/** Recarga en caliente el `source` de un path en MediaMTX (sin reiniciar). */
async function reloadMediamtxPath(name, source) {
  const res = await fetch(`${MEDIAMTX_API}/v3/config/paths/patch/${name}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, sourceOnDemand: false, rtspTransport: "tcp" }),
  });
  if (!res.ok && res.status !== 200) {
    throw new Error(`MediaMTX API HTTP ${res.status}`);
  }
}

/** Espera a que un path de MediaMTX vuelva a estar listo (con tracks), hasta `timeoutMs`. */
async function waitPathReady(name, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
      const json = await res.json();
      const p = json.items?.find((x) => x.name === name);
      if (p && p.ready && p.tracks && p.tracks.length > 0) return true;
    } catch {
      /* la API puede tardar un instante; reintentamos */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// API: cambiar la calidad/resolución de una cámara (alterna main/sub-stream).
// Body: { quality: "high" | "low" }
app.post("/api/cameras/:id/quality", async (req, res) => {
  try {
    const quality = req.body?.quality === "high" ? "high" : "low";
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    cam.quality = quality;
    saveConfig(config);

    // Recarga el stream en MediaMTX y espera a que el nuevo esté listo,
    // para que el cliente solo recargue cuando realmente hay imagen.
    let ready = false;
    try {
      await reloadMediamtxPath(cam.id, effectiveRtsp(cam));
      ready = await waitPathReady(cam.id);
    } catch (e) {
      console.warn("No se pudo recargar MediaMTX en caliente:", e.message);
      // No es fatal: la calidad queda guardada y se aplicará al reiniciar.
    }

    res.json({
      ok: true,
      quality,
      ready,
      camera: buildCameras(config).find((c) => c.id === cam.id),
    });
  } catch (err) {
    console.error("Error cambiando calidad:", err);
    res.status(500).json({ error: "No se pudo cambiar la calidad" });
  }
});

// API: enviar un comando PTZ a la cámara.
// Body: { direction, speed?, action? }
//   direction: up|down|left|right|upleft|upright|downleft|downright|zoomin|zoomout
//   action: "move" (por defecto) | "stop"
app.post("/api/cameras/:id/ptz", async (req, res) => {
  try {
    const { direction, speed, action = "move" } = req.body || {};
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const device = await getOnvifCam(cam);

    if (action === "stop") {
      device.stop({ panTilt: true, zoom: true }, (err) => {
        if (err) return res.status(502).json({ error: "Error al detener PTZ: " + err.message });
        res.json({ ok: true, action: "stop" });
      });
      return;
    }

    const v = ptzVector(direction, speed);
    if (!v) return res.status(400).json({ error: "Dirección PTZ no válida" });

    // timeout (ms): la cámara mantiene el movimiento sola hasta agotarlo o
    // recibir un stop. El frontend reenvía el comando (keep-alive) antes de
    // que expire, por si la cámara ignora el Timeout ONVIF. 2s da margen.
    device.continuousMove({ x: v.x, y: v.y, zoom: v.zoom, timeout: 2000 }, (err) => {
      if (err) return res.status(502).json({ error: "Error al mover PTZ: " + err.message });
      res.json({ ok: true, action: "move", direction });
    });
  } catch (err) {
    console.error("Error PTZ:", err);
    // Si la conexión falló, descartamos la caché para reintentar limpio.
    ptzCams.delete(req.params.id);
    res.status(502).json({
      error:
        "No se pudo conectar por ONVIF a la cámara. Verifica que ONVIF esté " +
        "activo y el puerto correcto. Detalle: " + err.message,
    });
  }
});

// API: eliminar una cámara por id.
app.delete("/api/cameras/:id", (req, res) => {
  try {
    const config = loadConfig();
    const before = config.cameras.length;
    config.cameras = config.cameras.filter((c) => c.id !== req.params.id);
    if (config.cameras.length === before) {
      return res.status(404).json({ error: "Cámara no encontrada" });
    }
    saveConfig(config);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error eliminando cámara:", err);
    res.status(500).json({ error: "No se pudo eliminar la cámara" });
  }
});

// Health check simple.
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// =====================================================================
//  Grabación (MediaMTX graba en disco; aquí gestionamos config y archivos)
// =====================================================================

/** Lista recursiva de archivos de vídeo (.mp4) dentro de una carpeta. */
function listVideoFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // la carpeta puede no existir aún
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listVideoFiles(full));
    } else if (/\.mp4$/i.test(e.name)) {
      try {
        const st = fs.statSync(full);
        out.push({ full, name: e.name, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* ignora archivos que desaparezcan a mitad */
      }
    }
  }
  return out;
}

/**
 * Parsea la hora de inicio de un segmento a partir de su nombre, que MediaMTX
 * genera como "YYYY-MM-DD_HH-MM-SS-ffffff.mp4" (ffffff = microsegundos).
 * Devuelve los milisegundos epoch, o null si el nombre no encaja.
 */
function parseSegmentStart(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{1,6})/.exec(name);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, frac] = m;
  const ms = Math.floor(Number(("0." + frac).slice(0, 9)) * 1000); // micro -> ms
  // El nombre está en hora LOCAL del servidor (igual que MediaMTX).
  const d = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S), ms);
  return d.getTime();
}

/**
 * Devuelve los segmentos de una cámara enriquecidos con tiempos:
 * start/end/duration (ms). La duración se estima como (inicio del siguiente −
 * inicio de este); para el último segmento se usa su mtime. Sin dependencias
 * externas (no requiere ffprobe).
 */
function segmentsWithTimes(camDir) {
  const segs = listVideoFiles(camDir)
    .map((f) => ({
      file: path.relative(camDir, f.full).replace(/\\/g, "/"),
      name: f.name,
      size: f.size,
      mtime: f.mtime,
      start: parseSegmentStart(f.name),
    }))
    .filter((s) => s.start != null)
    .sort((a, b) => a.start - b.start); // cronológico ascendente

  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    // Fin = inicio del siguiente si son consecutivos; si no, el mtime del archivo.
    const byNext = next ? next.start : null;
    const end = byNext != null && byNext > segs[i].start ? byNext : segs[i].mtime;
    segs[i].end = end;
    segs[i].duration = Math.max(0, end - segs[i].start);
  }
  return segs;
}

// Configuración global de grabación.
app.get("/api/recording/config", (req, res) => {
  try {
    const config = loadConfig();
    const rc = recordingConfig(config);
    // Uso de disco actual de la carpeta de grabaciones.
    const files = listVideoFiles(recordingsDir(config));
    const usedBytes = files.reduce((s, f) => s + f.size, 0);
    res.json({ recording: rc, stats: { files: files.length, usedBytes } });
  } catch (err) {
    console.error("Error leyendo config de grabación:", err);
    res.status(500).json({ error: "No se pudo leer la configuración de grabación" });
  }
});

app.put("/api/recording/config", (req, res) => {
  try {
    const body = req.body || {};
    const config = loadConfig();
    const current = recordingConfig(config);

    const next = { ...current };
    if (body.enabled != null) next.enabled = !!body.enabled;
    if (body.dir != null && String(body.dir).trim()) next.dir = String(body.dir).trim();
    if (body.retentionHours != null) {
      const h = Math.max(1, Math.floor(Number(body.retentionHours)));
      if (Number.isFinite(h)) next.retentionHours = h;
    }
    if (body.segmentDuration != null && String(body.segmentDuration).trim()) {
      // Acepta formatos de duración de MediaMTX: "1h", "30m", "15m"…
      if (/^\d+[smh]$/.test(String(body.segmentDuration).trim())) {
        next.segmentDuration = String(body.segmentDuration).trim();
      }
    }
    if (body.format === "fmp4" || body.format === "mp4") next.format = body.format;

    config.recording = next;
    saveConfig(config);

    const result = regenerateAndRestartMediaMtx();
    if (!result.ok) {
      return res.status(500).json({ error: result.error, recording: next });
    }
    res.json({ recording: next, restarted: true });
  } catch (err) {
    console.error("Error guardando config de grabación:", err);
    res.status(500).json({ error: "No se pudo guardar la configuración de grabación" });
  }
});

// Lista de grabaciones de una cámara (más recientes primero).
app.get("/api/cameras/:id/recordings", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const camDir = path.join(recordingsDir(config), cam.id);
    // Más recientes primero para la lista; el timeline reordena por su cuenta.
    const recordings = segmentsWithTimes(camDir).sort((a, b) => b.start - a.start);
    res.json({ recordings });
  } catch (err) {
    console.error("Error listando grabaciones:", err);
    res.status(500).json({ error: "No se pudieron listar las grabaciones" });
  }
});

// Línea de tiempo de una cámara: segmentos cronológicos + rango cubierto.
// Opcional ?from=ms&to=ms para filtrar a una ventana (p. ej. un día).
app.get("/api/cameras/:id/timeline", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const camDir = path.join(recordingsDir(config), cam.id);
    let segs = segmentsWithTimes(camDir); // ascendente

    const from = req.query.from != null ? Number(req.query.from) : null;
    const to = req.query.to != null ? Number(req.query.to) : null;
    if (from != null) segs = segs.filter((s) => s.end > from);
    if (to != null) segs = segs.filter((s) => s.start < to);

    const rangeStart = segs.length ? segs[0].start : null;
    const rangeEnd = segs.length ? segs[segs.length - 1].end : null;

    res.json({
      cameraId: cam.id,
      rangeStart,
      rangeEnd,
      segments: segs.map((s) => ({
        file: s.file,
        start: s.start,
        end: s.end,
        duration: s.duration,
        size: s.size,
      })),
    });
  } catch (err) {
    console.error("Error construyendo timeline:", err);
    res.status(500).json({ error: "No se pudo construir la línea de tiempo" });
  }
});

/**
 * Convierte una marca de tiempo del log de MediaMTX ("2026/06/27 11:14:11",
 * hora local) a ms epoch. Devuelve null si no encaja.
 */
function parseLogTime(s) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  return new Date(+Y, +Mo - 1, +D, +H, +Mi, +S).getTime();
}

/**
 * Historial de eventos de señal de una cámara, parseado del log de MediaMTX:
 *  - "loss": el origen RTSP se cortó (ERR ... [RTSP source] <motivo>).
 *  - "online": el stream volvió (INF ... stream is available and online).
 * Devuelve los más recientes primero, hasta `limit`.
 */
function readSignalEvents(camId, limit = 200) {
  let text;
  try {
    text = fs.readFileSync(MEDIAMTX_LOG, "utf-8");
  } catch {
    return [];
  }
  const lossRe = new RegExp(
    `^(.+?) ERR \\[path ${camId}\\] \\[RTSP source\\] (.+)$`
  );
  const onlineRe = new RegExp(
    `^(.+?) INF \\[path ${camId}\\] stream is available and online`
  );
  const events = [];
  // Recorremos de abajo (más reciente) hacia arriba y cortamos al llegar a limit.
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
    const line = lines[i];
    let m = lossRe.exec(line);
    if (m) {
      const at = parseLogTime(m[1]);
      if (at != null) events.push({ at, type: "loss", reason: m[2].trim() });
      continue;
    }
    m = onlineRe.exec(line);
    if (m) {
      const at = parseLogTime(m[1]);
      if (at != null) events.push({ at, type: "online", reason: "Señal recuperada" });
    }
  }
  return events; // ya en orden descendente por construcción
}

// Historial de pérdidas/recuperaciones de señal de una cámara (del log MediaMTX).
app.get("/api/cameras/:id/signal-events", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const events = readSignalEvents(cam.id, limit);
    const losses = events.filter((e) => e.type === "loss").length;
    res.json({ cameraId: cam.id, totalLosses: losses, events });
  } catch (err) {
    console.error("Error leyendo eventos de señal:", err);
    res.status(500).json({ error: "No se pudo leer el historial de señal" });
  }
});

// Fotograma de previsualización en un instante dado (ms epoch). Extrae 1 frame
// con FFmpeg y lo cachea en disco (redondeando a THUMB_STEP_MS para reutilizar
// hovers cercanos). Pensado para el preview del timeline al pasar el ratón.
const THUMB_STEP_MS = 2000; // resolución de caché: 1 miniatura cada 2s
app.get("/api/cameras/:id/frame", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const at = Number(req.query.at);
    if (!Number.isFinite(at)) {
      return res.status(400).json({ error: "Parámetro 'at' no válido" });
    }

    const camDir = path.join(recordingsDir(config), cam.id);
    const seg = segmentsWithTimes(camDir).find((s) => at >= s.start && at < s.end);
    if (!seg) return res.status(404).json({ error: "Sin grabación en ese instante" });

    // Instante redondeado para la caché (reutiliza hovers cercanos).
    const bucket = Math.floor(at / THUMB_STEP_MS) * THUMB_STEP_MS;
    const thumbDir = path.join(recordingsDir(config), ".thumbs", cam.id);
    const thumbPath = path.join(thumbDir, `${bucket}.jpg`);

    // Cache hit: sirve directamente.
    if (fs.existsSync(thumbPath)) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "max-age=86400");
      return fs.createReadStream(thumbPath).pipe(res);
    }

    fs.mkdirSync(thumbDir, { recursive: true });
    const offsetSec = (bucket - seg.start) / 1000;
    const input = path.join(camDir, seg.file);
    const ffmpeg = findFfmpeg();
    const args = [
      "-y",
      "-ss", Math.max(0, offsetSec).toFixed(3),
      "-i", input,
      "-frames:v", "1",
      "-vf", "scale=320:-1",
      "-q:v", "5",
      thumbPath,
    ];

    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      console.error("FFmpeg (frame) no disponible:", err.message);
      if (!res.headersSent)
        res.status(500).json({ error: "FFmpeg no está disponible" });
    });
    proc.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(thumbPath)) {
        console.error("FFmpeg (frame) falló:", stderr.slice(-300));
        if (!res.headersSent)
          res.status(500).json({ error: "No se pudo extraer el fotograma" });
        return;
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "max-age=86400");
      fs.createReadStream(thumbPath).pipe(res);
    });
  } catch (err) {
    console.error("Error extrayendo fotograma:", err);
    if (!res.headersSent)
      res.status(500).json({ error: "No se pudo extraer el fotograma" });
  }
});

// Exporta un clip MP4 único recortado a [from, to] (ms epoch), concatenando los
// segmentos necesarios con FFmpeg. Requiere FFmpeg (en tools/ o en el PATH).
app.get("/api/cameras/:id/export", (req, res) => {
  const tmpFiles = []; // a limpiar al terminar
  const cleanup = () => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignora */
      }
    }
  };
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return res.status(400).json({ error: "Rango (from/to) no válido" });
    }
    if (to - from > 6 * 3600 * 1000) {
      return res.status(400).json({ error: "El rango máximo de exportación es 6 horas" });
    }

    const ffmpeg = findFfmpeg();
    const camDir = path.join(recordingsDir(config), cam.id);
    // Segmentos que solapan el rango, en orden cronológico.
    const segs = segmentsWithTimes(camDir).filter((s) => s.end > from && s.start < to);
    if (segs.length === 0) {
      return res.status(404).json({ error: "No hay grabaciones en ese rango" });
    }

    // Carpeta temporal para los artefactos de FFmpeg.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuscam-export-"));
    const out = path.join(tmpDir, "clip.mp4");
    tmpFiles.push(out);

    let args;
    if (segs.length === 1) {
      // Un solo segmento: recorte directo con -ss/-to relativos al inicio.
      const ss = Math.max(0, (from - segs[0].start) / 1000);
      const dur = (Math.min(to, segs[0].end) - Math.max(from, segs[0].start)) / 1000;
      const input = path.join(camDir, segs[0].file);
      args = [
        "-y",
        "-ss", ss.toFixed(3),
        "-i", input,
        "-t", dur.toFixed(3),
        "-c:v", "libx264", "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        out,
      ];
    } else {
      // Varios segmentos: lista concat + recorte global al rango.
      const listFile = path.join(tmpDir, "concat.txt");
      tmpFiles.push(listFile);
      const listBody = segs
        .map((s) => `file '${path.join(camDir, s.file).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n");
      fs.writeFileSync(listFile, listBody, "utf-8");
      // Offset del rango respecto al inicio del primer segmento.
      const ss = Math.max(0, (from - segs[0].start) / 1000);
      const totalDur = (to - from) / 1000;
      args = [
        "-y",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-ss", ss.toFixed(3),
        "-t", totalDur.toFixed(3),
        "-c:v", "libx264", "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        out,
      ];
    }

    const proc = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      cleanup();
      console.error("FFmpeg no disponible:", err.message);
      if (!res.headersSent) {
        res.status(500).json({
          error:
            "FFmpeg no está disponible. Coloca ffmpeg.exe en la carpeta tools/ o en el PATH.",
        });
      }
    });
    proc.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(out)) {
        cleanup();
        console.error("FFmpeg falló (code " + code + "):", stderr.slice(-500));
        if (!res.headersSent) {
          res.status(500).json({ error: "FFmpeg falló al exportar el clip" });
        }
        return;
      }
      const fromStr = new Date(from)
        .toLocaleString("sv")
        .replace(/[: ]/g, "-"); // YYYY-MM-DD-HH-MM-SS
      const filename = `${cam.id}_${fromStr}.mp4`;
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const stream = fs.createReadStream(out);
      stream.pipe(res);
      stream.on("close", () => {
        cleanup();
        try {
          fs.rmdirSync(tmpDir);
        } catch {
          /* ignora */
        }
      });
    });
  } catch (err) {
    cleanup();
    console.error("Error exportando clip:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "No se pudo exportar el clip" });
    }
  }
});

// Sirve un archivo de grabación concreto (con soporte de Range para seek).
app.get("/api/cameras/:id/recordings/:file(*)", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const camDir = path.join(recordingsDir(config), cam.id);
    // Resuelve y valida que el archivo esté DENTRO de la carpeta de la cámara
    // (evita path traversal con "../").
    const target = path.resolve(camDir, req.params.file);
    if (!target.startsWith(path.resolve(camDir) + path.sep)) {
      return res.status(400).json({ error: "Ruta no válida" });
    }
    if (!fs.existsSync(target)) {
      return res.status(404).json({ error: "Grabación no encontrada" });
    }

    const stat = fs.statSync(target);
    const range = req.headers.range;
    const download = req.query.download != null;
    res.setHeader("Content-Type", "video/mp4");
    if (download) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(target)}"`
      );
    }

    if (range) {
      // Respuesta parcial para que el <video> pueda hacer seek.
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size) {
        res.setHeader("Content-Range", `bytes */${stat.size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", end - start + 1);
      fs.createReadStream(target, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Accept-Ranges", "bytes");
      fs.createReadStream(target).pipe(res);
    }
  } catch (err) {
    console.error("Error sirviendo grabación:", err);
    res.status(500).json({ error: "No se pudo servir la grabación" });
  }
});

// Proxy HLS y WebRTC hacia MediaMTX por el mismo origen que la web/API.
// Reenvía cookies, query strings y headers (necesario para las sesiones HLS
// de MediaMTX). Permite que el video funcione en LAN y por el túnel de internet.
const hlsPortInit = (() => {
  try {
    return loadConfig().hlsPort || 8888;
  } catch {
    return 8888;
  }
})();
const webrtcPortInit = (() => {
  try {
    return loadConfig().webrtcPort || 8889;
  } catch {
    return 8889;
  }
})();

app.use(
  "/hls",
  createProxyMiddleware({
    target: `http://localhost:${hlsPortInit}`,
    changeOrigin: true,
    pathRewrite: { "^/hls": "" },
    ws: false,
    on: {
      // MediaMTX redirige a rutas absolutas SIN el prefijo /hls; las reescribimos
      // para que el cliente siga el redirect a través del proxy (y no caiga en
      // el catch-all que sirve index.html).
      proxyRes: (proxyRes) => {
        const loc = proxyRes.headers["location"];
        if (loc && loc.startsWith("/") && !loc.startsWith("/hls")) {
          proxyRes.headers["location"] = "/hls" + loc;
        }
      },
    },
  })
);

// Proxy WebRTC/WHEP (para que también funcione por el mismo origen).
app.use(
  "/whep",
  createProxyMiddleware({
    target: `http://localhost:${webrtcPortInit}`,
    changeOrigin: true,
    pathRewrite: { "^/whep": "" },
  })
);

// Sirve el frontend web de escritorio compilado (si existe el build).
if (fs.existsSync(DESKTOP_DIST)) {
  app.use(express.static(DESKTOP_DIST));
  app.get("*", (req, res) => {
    res.sendFile(path.join(DESKTOP_DIST, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res
      .status(200)
      .send(
        "Backend cuscam activo. El frontend de escritorio aún no está compilado " +
          "(ejecuta `npm run build` en /desktop). API disponible en /api/cameras"
      );
  });
}

app.listen(PORT, () => {
  console.log(`cuscam backend escuchando en http://localhost:${PORT}`);
  console.log(`  -> API cámaras:  http://localhost:${PORT}/api/cameras`);
});
