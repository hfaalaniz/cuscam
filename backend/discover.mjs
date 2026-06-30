/**
 * Módulo de descubrimiento de cámaras IP en la red local.
 *
 * Capacidades (todas best-effort, tolerantes a fallos):
 *   · scanNetwork()  — ping sweep del /24 + lectura de la tabla ARP → hosts vivos.
 *   · onvifDiscover()— WS-Discovery multicast (cámaras ONVIF se anuncian).
 *   · scanPorts(ip)  — sondeo TCP de los puertos típicos de cámara.
 *   · probeRtsp(...) — fuerza bruta de rutas + credenciales conocidas, validando
 *                       con ffprobe que realmente hay un stream de vídeo.
 *
 * No usa dependencias externas salvo `node:net`/`node:dgram`/`child_process` y
 * el binario ffprobe (ruta inyectada por el llamador).
 */
import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

// --- Catálogos para la fuerza bruta RTSP (marcas comunes de cámara china/genérica) ---

// Rutas RTSP conocidas, de más a menos probable. {p} se sustituye por el
// "stream" (alta/baja) cuando aplica.
export const RTSP_PATHS = [
  "/onvif1", // Yoosee/Gwell alta
  "/onvif2", // Yoosee/Gwell baja
  "/live/ch00_1", // V380 baja
  "/live/ch00_0", // V380 alta
  "/11", // Hikvision-like / genérico
  "/12",
  "/h264", // genérico
  "/h264_stream",
  "/live/main",
  "/live/sub",
  "/stream1",
  "/stream2",
  "/video1",
  "/cam/realmonitor?channel=1&subtype=0", // Dahua alta
  "/cam/realmonitor?channel=1&subtype=1", // Dahua baja
  "/Streaming/Channels/101", // Hikvision alta
  "/Streaming/Channels/102", // Hikvision baja
  "/ch0_0.h264",
  "/ch0_1.h264",
  "/0", // algunos genéricos
  "/1",
  "/", // raíz
];

// Credenciales por defecto típicas: [usuario, contraseña].
export const RTSP_CREDS = [
  ["", ""], // sin auth (muchas Yoosee/Gwell)
  ["admin", ""],
  ["admin", "admin"],
  ["admin", "12345"],
  ["admin", "123456"],
  ["admin", "888888"],
  ["admin", "9999"],
  ["admin", "password"],
  ["root", "root"],
  ["user", "user"],
];

// Puertos TCP típicos de cámara (RTSP / HTTP / ONVIF / propietarios).
export const CAMERA_PORTS = [554, 8554, 10554, 80, 8080, 8000, 81, 5000, 8899, 88, 34567];

/** ¿Comparten `ip` y `other` el mismo /24 (primeros 3 octetos)? */
function sameClassC(ip, other) {
  if (!ip || !other) return false;
  return ip.split(".").slice(0, 3).join(".") === other.split(".").slice(0, 3).join(".");
}

/**
 * IP/máscara de la LAN real del host. Descarta interfaces internas, las VPN
 * tipo Tailscale (100.64.0.0/10 o máscara /32) y los adaptadores virtuales de
 * VM (VirtualBox 192.168.56.x, etc.). Si se pasa `preferIp` (p.ej. el
 * `windowsHostIp` de la config), se elige la interfaz de ESA subred — la forma
 * más fiable cuando hay varias 192.168.x.
 */
export function localSubnet(preferIp = null) {
  const candidates = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const a of iface || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.netmask === "255.255.255.255") continue; // /32 = VPN punto a punto
      const o = a.address.split(".").map(Number);
      if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) continue; // CGNAT/Tailscale
      const isVmNet = o[0] === 192 && o[1] === 168 && o[2] === 56; // VirtualBox
      const isPrivate =
        (o[0] === 192 && o[1] === 168) ||
        o[0] === 10 ||
        (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
      candidates.push({ ip: a.address, netmask: a.netmask, isPrivate, isVmNet });
    }
  }
  // 1) La interfaz de la subred indicada por preferIp (lo más fiable).
  const byPrefer = candidates.find((c) => sameClassC(c.ip, preferIp));
  if (byPrefer) return { ip: byPrefer.ip, netmask: byPrefer.netmask };
  // 2) Una IP privada doméstica que NO sea de VM.
  const home = candidates.find((c) => c.isPrivate && !c.isVmNet);
  if (home) return { ip: home.ip, netmask: home.netmask };
  // 3) Lo que haya.
  const best = candidates[0];
  return best ? { ip: best.ip, netmask: best.netmask } : null;
}

/** Comprueba si un puerto TCP está abierto (resuelve true/false, nunca lanza). */
export function checkPort(ip, port, timeout = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (open) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(open);
    };
    s.setTimeout(timeout);
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
    s.connect(port, ip);
  });
}

/** Sondea los puertos de cámara de una IP. Devuelve los abiertos. */
export async function scanPorts(ip, ports = CAMERA_PORTS, timeout = 600) {
  const results = await Promise.all(
    ports.map((p) => checkPort(ip, p, timeout).then((open) => (open ? p : null)))
  );
  return results.filter((p) => p != null);
}

/**
 * Escanea el /24 local: abre el puerto 554 (RTSP) o 80 contra cada IP. Un host
 * que acepte alguno es "vivo y candidato a cámara". Es rápido (paralelo) y no
 * depende de ICMP (que Windows suele bloquear). Devuelve [{ ip, openPorts }].
 */
export async function scanNetwork({
  ports = [554, 80, 8000, 8899],
  timeout = 500,
  preferIp = null,
  subnetBase = null, // "192.168.50" para escanear OTRA /24 (p.ej. red remota por túnel)
} = {}) {
  let base;
  let selfIp = null;
  if (subnetBase && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnetBase)) {
    // Subred explícita (red remota alcanzable por VPN/túnel). No exige interfaz local.
    base = subnetBase;
  } else {
    const sub = localSubnet(preferIp);
    if (!sub) return { error: "No se detectó la red local", hosts: [] };
    base = sub.ip.split(".").slice(0, 3).join(".");
    selfIp = sub.ip;
  }
  const hosts = [];
  const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`).filter(
    (ip) => ip !== selfIp
  );
  // Lotes para no abrir miles de sockets a la vez.
  const BATCH = 64;
  for (let i = 0; i < ips.length; i += BATCH) {
    const slice = ips.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (ip) => {
        const open = await scanPorts(ip, ports, timeout);
        if (open.length) hosts.push({ ip, openPorts: open });
      })
    );
  }
  hosts.sort((a, b) => {
    const n = (x) => Number(x.ip.split(".")[3]);
    return n(a) - n(b);
  });
  return { subnet: base + ".0/24", hosts };
}

/**
 * WS-Discovery (ONVIF): envía un Probe multicast y recoge las respuestas
 * unicast de las cámaras. Devuelve [{ ip, xaddrs }].
 */
export function onvifDiscover({ timeout = 4000, preferIp = null } = {}) {
  return new Promise((resolve) => {
    const sub = localSubnet(preferIp);
    const probe =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ` +
      `xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
      `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ` +
      `xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
      `<e:Header><w:MessageID>uuid:${randomUUID()}</w:MessageID>` +
      `<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
      `<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>` +
      `</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>` +
      `</e:Body></e:Envelope>`;

    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const byIp = new Map();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      resolve([...byIp.values()]);
    };

    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      const s = msg.toString();
      const xaddrs = (s.match(/XAddrs>([^<]+)</i) || [])[1] || "";
      byIp.set(rinfo.address, { ip: rinfo.address, xaddrs: xaddrs.trim() });
    });

    sock.bind(0, sub ? sub.ip : undefined, () => {
      try { if (sub) sock.setMulticastInterface(sub.ip); } catch {}
      const buf = Buffer.from(probe);
      sock.send(buf, 0, buf.length, 3702, "239.255.255.250", (err) => {
        if (err) finish();
      });
    });

    setTimeout(finish, timeout).unref?.();
  });
}

/** Construye una URL RTSP a partir de partes (codifica credenciales). */
function buildRtspUrl({ user, password, ip, port, path }) {
  const creds =
    user || password
      ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`
      : "";
  return `rtsp://${creds}${ip}:${port}${path}`;
}

/**
 * Valida una URL RTSP con ffprobe: ¿hay un stream de vídeo legible? Resuelve
 * { ok, codec, width, height } o { ok:false }. Mata el proceso al timeout.
 */
export function ffprobeRtsp(ffprobePath, url, timeout = 6000) {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-rtsp_transport", "tcp",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height",
      "-of", "json",
      "-rw_timeout", String(timeout * 1000), // microsegundos
      "-i", url,
    ];
    let out = "";
    const child = spawn(ffprobePath, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ ok: false });
    }, timeout);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out || "{}");
        const v = (json.streams || [])[0];
        if (v && v.codec_name) {
          resolve({ ok: true, codec: v.codec_name, width: v.width, height: v.height });
          return;
        }
      } catch {
        /* sin JSON válido = sin stream */
      }
      resolve({ ok: false });
    });
  });
}

/**
 * Sonda RTSP exhaustiva sobre una IP: prueba combinaciones de puerto×ruta×
 * credenciales hasta encontrar una que ffprobe valide como vídeo. Devuelve la
 * primera que funcione: { found:true, rtsp, codec, width, height } o
 * { found:false, tried }.
 *
 * `onProgress(msg)` opcional para feedback en vivo.
 */
export async function probeRtsp(
  ffprobePath,
  ip,
  {
    ports = [554, 8554, 10554],
    paths = RTSP_PATHS,
    creds = RTSP_CREDS,
    timeout = 5000,
    onProgress,
  } = {}
) {
  // Solo probamos puertos RTSP que estén realmente abiertos (ahorra muchísimo).
  const openRtsp = [];
  for (const p of ports) {
    if (await checkPort(ip, p, 700)) openRtsp.push(p);
  }
  if (!openRtsp.length) {
    return { found: false, reason: "no-rtsp-port", tried: 0 };
  }

  let tried = 0;
  for (const port of openRtsp) {
    for (const path of paths) {
      for (const [user, password] of creds) {
        const url = buildRtspUrl({ user, password, ip, port, path });
        tried++;
        onProgress?.(`probando ${ip}:${port}${path} (${user || "sin-user"})`);
        const r = await ffprobeRtsp(ffprobePath, url, timeout);
        if (r.ok) {
          return {
            found: true,
            rtsp: url,
            port,
            path,
            user,
            password,
            codec: r.codec,
            width: r.width,
            height: r.height,
            tried,
          };
        }
      }
    }
  }
  return { found: false, reason: "no-match", tried };
}
