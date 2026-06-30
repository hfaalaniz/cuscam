import express from "express";
import cors from "cors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import onvif from "onvif";
import { createProxyMiddleware } from "http-proxy-middleware";
import { scanNetwork, onvifDiscover, scanPorts, probeRtsp, RTSP_CREDS } from "./discover.mjs";

const { Cam } = onvif;

const IS_WINDOWS = process.platform === "win32";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "cameras.json");
const DESKTOP_DIST = path.join(ROOT, "desktop", "dist");
const GENERATOR = path.join(ROOT, "server", "generate-mediamtx-config.mjs");
const GENERATED_YML = path.join(ROOT, "server", "mediamtx.yml");

/**
 * Localiza la carpeta de MediaMTX de forma multiplataforma. Acepta:
 *  · MEDIAMTX_DIR en el entorno (override manual),
 *  · una carpeta `mediamtx/` en la raíz (recomendado en Linux),
 *  · cualquier `mediamtx_*` (los zips oficiales: ..._windows_amd64, _linux_arm64…).
 * Si no encuentra carpeta, asume `mediamtx` en el PATH del sistema.
 */
function findMediamtxDir() {
  if (process.env.MEDIAMTX_DIR) return process.env.MEDIAMTX_DIR;
  const direct = path.join(ROOT, "mediamtx");
  if (fs.existsSync(path.join(direct, IS_WINDOWS ? "mediamtx.exe" : "mediamtx"))) {
    return direct;
  }
  try {
    const match = fs
      .readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^mediamtx_/i.test(e.name))
      .map((e) => path.join(ROOT, e.name))
      .find((dir) => fs.existsSync(path.join(dir, IS_WINDOWS ? "mediamtx.exe" : "mediamtx")));
    if (match) return match;
  } catch {
    /* ignorar */
  }
  return direct; // fallback (puede no existir; el binario se buscará en PATH)
}

const MEDIAMTX_DIR = findMediamtxDir();
const MEDIAMTX_BIN = IS_WINDOWS ? "mediamtx.exe" : "mediamtx";
const MEDIAMTX_EXE = path.join(MEDIAMTX_DIR, MEDIAMTX_BIN);
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

/** Localiza ffprobe.exe (junto a ffmpeg en tools/). Devuelve ruta o "ffprobe". */
function findFfprobe() {
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
      else if (/^ffprobe(\.exe)?$/i.test(e.name)) return full;
    }
  }
  return "ffprobe";
}

/**
 * Escanea las webcams USB/locales (dispositivos DirectShow de vídeo) que ve
 * Windows, junto con las resoluciones y fps que soporta cada una. Usa FFmpeg
 * (`-list_devices` y `-list_options`), que escribe esta info por stderr.
 * Devuelve [{ device, formats:[{ size, minFps, maxFps }] }].
 */
function scanDshowDevices() {
  const ffmpeg = findFfmpeg();
  // 1. Listar dispositivos. FFmpeg sale con código !=0 (no hay input real),
  //    pero igualmente imprime la lista por stderr; la parseamos.
  const list = spawnSync(
    ffmpeg,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf-8" }
  );
  const out = `${list.stderr || ""}`;
  const videoNames = [];
  // Cada dispositivo de vídeo aparece como:  "Nombre" (video)
  // (las líneas "Alternative name" y "(audio)" se ignoran).
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/"([^"]+)"\s*\(video\)/i);
    if (m) videoNames.push(m[1]);
  }

  // 2. Para cada dispositivo, listar sus formatos (resolución + fps).
  return videoNames.map((device) => ({ device, formats: dshowFormats(ffmpeg, device) }));
}

/** Lee los formatos (size + rango de fps) soportados por un dispositivo dshow. */
function dshowFormats(ffmpeg, device) {
  const r = spawnSync(
    ffmpeg,
    ["-hide_banner", "-list_options", "true", "-f", "dshow", "-i", `video=${device}`],
    { encoding: "utf-8" }
  );
  const out = `${r.stderr || ""}`;
  // Deduplicamos por "size", quedándonos con el rango de fps más amplio visto.
  const bySize = new Map();
  for (const line of out.split(/\r?\n/)) {
    // ... min s=640x480 fps=5 max s=640x480 fps=30 ...
    const m = line.match(/min s=(\d+x\d+) fps=([\d.]+) max s=(\d+x\d+) fps=([\d.]+)/i);
    if (!m) continue;
    const size = m[3]; // el "max" suele ser el tamaño efectivo de ese modo
    const minFps = Math.round(parseFloat(m[2]));
    const maxFps = Math.round(parseFloat(m[4]));
    const prev = bySize.get(size);
    if (!prev) bySize.set(size, { size, minFps, maxFps });
    else {
      prev.minFps = Math.min(prev.minFps, minFps);
      prev.maxFps = Math.max(prev.maxFps, maxFps);
    }
  }
  // Orden: mayor resolución primero (área de píxeles).
  return [...bySize.values()].sort((a, b) => {
    const area = (s) => s.size.split("x").reduce((x, y) => x * Number(y), 1);
    return area(b) - area(a);
  });
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
  // 3. Reiniciar MediaMTX.
  // Si corre como servicio systemd (Linux), reiniciarlo por ahí es lo más
  // limpio; sirve también cuando lo lanzó el propio backend.
  if (!IS_WINDOWS && process.env.MEDIAMTX_SYSTEMD) {
    const r = spawnSync("systemctl", ["restart", process.env.MEDIAMTX_SYSTEMD], {
      encoding: "utf-8",
    });
    return r.status === 0
      ? { ok: true }
      : { ok: false, error: "No se pudo reiniciar el servicio MediaMTX: " + (r.stderr || "") };
  }
  // Modo manual (Windows o Linux sin systemd): matar el proceso y relanzarlo.
  try {
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/IM", "mediamtx.exe", "/F"], { encoding: "utf-8" });
    } else {
      spawnSync("pkill", ["-f", "mediamtx"], { encoding: "utf-8" });
    }
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
 * Reconoce el patrón main/sub-stream de varias marcas:
 *   · V380:      ch00_0 (alta) / ch00_1 (baja)
 *   · Hikvision: /Streaming/Channels/101 (alta) / 102 (baja)
 *   · Dahua:     subtype=0 (alta) / subtype=1 (baja)
 * Elegir "low" (sub-stream) reduce mucho el ancho de banda — útil para
 * cámaras remotas grabadas por túnel. Por defecto mantiene la ruta tal cual.
 */
function effectiveRtsp(cam) {
  // Las webcams USB no tienen RTSP propio (las publica FFmpeg); no aplica.
  if (cam.source === "usb") return cam.rtsp || "";
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
    // Tipo de fuente: "usb" (webcam DirectShow) o IP/RTSP (V380) por defecto.
    source: cam.source === "usb" ? "usb" : "rtsp",
    ...(cam.source === "usb"
      ? { device: cam.device, size: cam.size || "640x480", fps: cam.fps || 15 }
      : {}),
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

// API: escanear webcams USB/locales (dispositivos DirectShow) disponibles, con
// sus resoluciones/fps soportados. Marca cuáles ya están añadidas (`inUse`).
app.get("/api/usb-cameras/scan", (req, res) => {
  try {
    const devices = scanDshowDevices();
    const config = loadConfig();
    const used = new Set(
      config.cameras.filter((c) => c.source === "usb").map((c) => c.device)
    );
    res.json({
      devices: devices.map((d) => ({ ...d, inUse: used.has(d.device) })),
    });
  } catch (err) {
    console.error("Error escaneando cámaras USB:", err);
    res.status(500).json({ error: "No se pudieron escanear las cámaras USB" });
  }
});

// --- Descubrimiento de cámaras IP en la red local ---

// Escanea la LAN buscando hosts con puertos de cámara abiertos, y en paralelo
// hace ONVIF WS-Discovery. Marca cuáles ya están en la config (por IP). Usa el
// windowsHostIp de la config como pista para elegir la interfaz/subred correcta.
app.get("/api/discover/network", async (req, res) => {
  try {
    const config = loadConfig();
    const preferIp = config.windowsHostIp || null;
    // ?subnet=192.168.50 escanea OTRA /24 (red remota alcanzable por VPN/túnel,
    // p.ej. cámaras Hikvision en otro sitio vía Tailscale subnet-router).
    const subnetBase = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(req.query.subnet || "")
      ? req.query.subnet
      : null;
    // El ONVIF multicast solo funciona en la LAN local; en subred remota se
    // confía en el escaneo de puertos (las Hikvision exponen 554/80).
    const [scan, onvif] = await Promise.all([
      scanNetwork({ preferIp, subnetBase }),
      subnetBase ? Promise.resolve([]) : onvifDiscover({ timeout: 4000, preferIp }),
    ]);

    // IPs ya configuradas (extraídas de las URLs RTSP existentes).
    const usedIps = new Set(
      config.cameras
        .filter((c) => c.source !== "usb" && c.rtsp)
        .map((c) => parseRtsp(c.rtsp).ip)
        .filter(Boolean)
    );
    const onvifIps = new Set(onvif.map((o) => o.ip));

    const hosts = (scan.hosts || [])
      // El propio host y el router no son cámaras.
      .filter((h) => h.ip !== preferIp)
      .map((h) => ({
        ip: h.ip,
        openPorts: h.openPorts,
        onvif: onvifIps.has(h.ip),
        onvifXaddr: (onvif.find((o) => o.ip === h.ip) || {}).xaddrs || "",
        // Heurística: si tiene 554 (RTSP) u ONVIF, es muy probable que sea cámara.
        likelyCamera: h.openPorts.includes(554) || onvifIps.has(h.ip),
        inUse: usedIps.has(h.ip),
      }));

    res.json({ subnet: scan.subnet, hosts });
  } catch (err) {
    console.error("Error en descubrimiento de red:", err);
    res.status(500).json({ error: "No se pudo escanear la red" });
  }
});

// Sondea exhaustivamente una IP: prueba puertos, y luego fuerza bruta de rutas
// RTSP × credenciales conocidas validando con ffprobe que haya vídeo real.
// Devuelve la URL RTSP que funcione (o el motivo del fallo).
// Body opcional: { user, password } para probar primero esas credenciales.
app.post("/api/discover/probe", async (req, res) => {
  try {
    const ip = String((req.body || {}).ip || "").trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return res.status(400).json({ error: "IP inválida" });
    }
    const ffprobe = findFfprobe();

    // Si el usuario aporta credenciales, las probamos primero (además de las
    // por defecto), para no depender solo del diccionario.
    const { user, password } = req.body || {};
    const baseCreds = [];
    if (user != null || password != null) {
      baseCreds.push([String(user || ""), String(password || "")]);
    }

    const ports = await scanPorts(ip, [554, 8554, 10554], 700);
    const result = await probeRtsp(ffprobe, ip, {
      ports: ports.length ? ports : [554, 8554, 10554],
      creds: baseCreds.length
        ? [...baseCreds, ...RTSP_CREDS]
        : RTSP_CREDS,
      timeout: 5000,
    });
    res.json({ ip, ...result });
  } catch (err) {
    console.error("Error sondeando RTSP:", err);
    res.status(500).json({ error: "No se pudo sondear la cámara" });
  }
});

// API: añadir una cámara nueva.
// Cámara IP: { name, ip, port?, path?, user?, password?, deviceId?, model? }
//            o { name, rtsp } para pasar la URL completa.
// Cámara USB: { name, source:"usb", device, size?, fps?, model? }
app.post("/api/cameras", (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "El nombre es obligatorio" });
    }

    const isUsb = body.source === "usb";
    let rtsp = "";

    if (isUsb) {
      if (!String(body.device || "").trim()) {
        return res.status(400).json({ error: "Falta el dispositivo USB (device)" });
      }
    } else {
      // Construye la URL RTSP a partir de campos o usa la provista directamente.
      rtsp = (body.rtsp || "").trim();
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
    }

    const config = loadConfig();

    // No permitir añadir dos veces el mismo dispositivo USB.
    if (isUsb && config.cameras.some((c) => c.source === "usb" && c.device === body.device)) {
      return res.status(409).json({ error: "Esa cámara USB ya está añadida" });
    }

    // id: deviceId (IP) o slug del dispositivo/nombre (USB). Garantiza unicidad.
    let id = isUsb
      ? `cam-usb-${slugify(body.device)}`
      : body.deviceId
        ? `cam${slugify(body.deviceId)}`
        : slugify(name);
    if (!id) id = "cam";
    const existingIds = new Set(config.cameras.map((c) => c.id));
    let uniqueId = id;
    let n = 2;
    while (existingIds.has(uniqueId)) {
      uniqueId = `${id}-${n++}`;
    }

    let camera;
    if (isUsb) {
      camera = {
        id: uniqueId,
        name,
        source: "usb",
        device: String(body.device),
        size: /^\d+x\d+$/.test(body.size) ? body.size : "640x480",
        fps: Math.max(1, Math.min(60, Math.floor(Number(body.fps) || 15))),
        quality: "low",
      };
      if (body.model) camera.model = String(body.model);
    } else {
      camera = { id: uniqueId, name, rtsp };
      if (body.deviceId) camera.deviceId = String(body.deviceId);
      if (body.model) camera.model = String(body.model);
    }

    config.cameras.push(camera);
    saveConfig(config);

    // Toda cámara nueva (IP o USB) requiere regenerar el mediamtx.yml y recargar
    // MediaMTX para que empiece a tomar el stream; si no, la ventana queda "sin
    // señal" hasta el próximo reinicio. Lo hacemos en caliente al añadir.
    let restarted = false;
    const result = regenerateAndRestartMediaMtx();
    if (!result.ok) {
      return res
        .status(500)
        .json({ error: result.error, camera: buildCameras(config).find((c) => c.id === uniqueId) });
    }
    restarted = true;

    res.status(201).json({
      camera: buildCameras(config).find((c) => c.id === uniqueId),
      restarted,
    });
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

    if (cam.source === "usb") {
      return res.json({
        camera: {
          id: cam.id,
          name: cam.name || "",
          model: cam.model || "",
          source: "usb",
          device: cam.device || "",
          size: cam.size || "640x480",
          fps: cam.fps || 15,
        },
      });
    }

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

    // --- Cámara USB: solo aplican device/size/fps; cambiarlos exige regenerar. ---
    let usbChanged = false;
    if (cam.source === "usb") {
      if (body.device != null && String(body.device).trim() && body.device !== cam.device) {
        cam.device = String(body.device).trim();
        usbChanged = true;
      }
      if (body.size != null && /^\d+x\d+$/.test(body.size) && body.size !== cam.size) {
        cam.size = body.size;
        usbChanged = true;
      }
      if (body.fps != null) {
        const fps = Math.max(1, Math.min(60, Math.floor(Number(body.fps))));
        if (Number.isFinite(fps) && fps !== cam.fps) {
          cam.fps = fps;
          usbChanged = true;
        }
      }
    } else {
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
    let restarted = false;
    if (recordChanged || usbChanged) {
      regenerateAndRestartMediaMtx();
      restarted = true;
    }
    res.json({ camera: buildCameras(config).find((c) => c.id === cam.id), restarted });
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
    if (cam.source === "usb") {
      return res
        .status(400)
        .json({ error: "El cambio de calidad no aplica a cámaras USB" });
    }

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
    // Regenera el yml y recarga MediaMTX para que deje de tomar la cámara
    // eliminada (si no, su path seguiría activo hasta el próximo reinicio).
    regenerateAndRestartMediaMtx();
    res.json({ ok: true, restarted: true });
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
/** Convierte una duración de MediaMTX ("15m","1h","30s") a milisegundos. */
function parseDurationMs(str) {
  const m = String(str || "").match(/^(\d+)\s*([smh])$/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "h" ? n * 3600000 : m[2] === "m" ? n * 60000 : n * 1000;
}

/**
 * Lista los segmentos con su rango temporal real.
 * `maxSegmentMs`: duración máxima de un segmento (la configurada, p.ej. 15m).
 * Es CLAVE para no inflar la duración cuando hay HUECOS entre grabaciones:
 * antes el `end` se ponía al inicio del siguiente segmento aunque estuviera
 * horas después, pintando un segmento de 15min como si durara 9h y descuadrando
 * el cursor/preview. Ahora acotamos el fin a inicio+maxSegmentMs (con margen).
 */
function segmentsWithTimes(camDir, maxSegmentMs = null) {
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

  // Tope de duración por segmento: la configurada +20% de margen; si no se
  // conoce, 1h como salvaguarda razonable.
  const cap = maxSegmentMs != null ? Math.round(maxSegmentMs * 1.2) : 3600000;

  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    // Candidatos a "fin": inicio del siguiente (si es contiguo) y el mtime.
    const byNext = next && next.start > segs[i].start ? next.start : null;
    const byMtime = segs[i].mtime > segs[i].start ? segs[i].mtime : null;
    // Preferimos el siguiente segmento, pero acotado: si está demasiado lejos
    // (hubo un hueco), usamos el mtime o el tope de duración configurado.
    let end;
    if (byNext != null) {
      end = Math.min(byNext, segs[i].start + cap);
      // Si el mtime cae entre medias y es más fiable que el tope, úsalo.
      if (byMtime != null && byMtime < end && byMtime > segs[i].start) end = byMtime;
    } else {
      end = byMtime != null ? Math.min(byMtime, segs[i].start + cap) : segs[i].start + cap;
    }
    segs[i].end = end;
    segs[i].duration = Math.max(0, end - segs[i].start);
  }
  return segs;
}

/** segmentsWithTimes para una cámara, tomando el maxSegmentMs de la config. */
function segmentsForCamera(config, camDir) {
  const maxMs = parseDurationMs(recordingConfig(config).segmentDuration);
  return segmentsWithTimes(camDir, maxMs);
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
    const recordings = segmentsForCamera(config, camDir).sort((a, b) => b.start - a.start);
    res.json({ recordings });
  } catch (err) {
    console.error("Error listando grabaciones:", err);
    res.status(500).json({ error: "No se pudieron listar las grabaciones" });
  }
});

// Días con grabación de una cámara (para el selector de fechas del visor).
// Devuelve [{ day:"YYYY-MM-DD", segments, start, end }] ordenado descendente
// (más recientes primero). El día se calcula en hora LOCAL del servidor.
app.get("/api/cameras/:id/recording-days", (req, res) => {
  try {
    const config = loadConfig();
    const cam = config.cameras.find((c) => c.id === req.params.id);
    if (!cam) return res.status(404).json({ error: "Cámara no encontrada" });

    const camDir = path.join(recordingsDir(config), cam.id);
    const byDay = new Map();
    for (const s of segmentsForCamera(config, camDir)) {
      const d = new Date(s.start);
      // Clave YYYY-MM-DD en hora local (el nombre del archivo ya es hora local).
      const key =
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
        `${String(d.getDate()).padStart(2, "0")}`;
      const cur = byDay.get(key) || { day: key, segments: 0, start: s.start, end: s.end };
      cur.segments += 1;
      cur.start = Math.min(cur.start, s.start);
      cur.end = Math.max(cur.end, s.end);
      byDay.set(key, cur);
    }
    const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    res.json({ days });
  } catch (err) {
    console.error("Error listando días de grabación:", err);
    res.status(500).json({ error: "No se pudieron listar los días" });
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
    let segs = segmentsForCamera(config, camDir); // ascendente

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
    const seg = segmentsForCamera(config, camDir).find((s) => at >= s.start && at < s.end);
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
    const segs = segmentsForCamera(config, camDir).filter((s) => s.end > from && s.start < to);
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
