import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import onvif from "onvif";
import { createProxyMiddleware } from "http-proxy-middleware";

const { Cam } = onvif;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "cameras.json");
const DESKTOP_DIST = path.join(ROOT, "desktop", "dist");

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

    saveConfig(config);
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

    device.continuousMove({ x: v.x, y: v.y, zoom: v.zoom }, (err) => {
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
