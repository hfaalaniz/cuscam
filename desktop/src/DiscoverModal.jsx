import { useEffect, useState } from "react";
import FloatingWindow from "./FloatingWindow.jsx";
import PasswordInput from "./PasswordInput.jsx";

/**
 * Modal unificado de descubrimiento de cámaras (un solo botón para todo):
 *  · Pestaña RED: escanea la LAN (GET /api/discover/network), lista hosts con
 *    pinta de cámara, y al elegir uno lo sondea (POST /api/discover/probe)
 *    probando rutas/credenciales RTSP hasta validar vídeo con ffprobe. Si lo
 *    encuentra, se añade con un click.
 *  · Pestaña USB: escanea webcams DirectShow (GET /api/usb-cameras/scan) y las
 *    añade eligiendo resolución/fps.
 */
export default function DiscoverModal({ onClose, onAdded }) {
  const [tab, setTab] = useState("ip");
  return (
    <FloatingWindow title="Descubrir cámaras" onClose={onClose} wide>
      <div className="discover-tabs">
        <button
          className={"tab" + (tab === "ip" ? " tab-on" : "")}
          onClick={() => setTab("ip")}
        >
          🌐 Cámaras IP (red)
        </button>
        <button
          className={"tab" + (tab === "usb" ? " tab-on" : "")}
          onClick={() => setTab("usb")}
        >
          🎥 Cámaras USB
        </button>
      </div>
      {tab === "ip" ? (
        <IpDiscovery onClose={onClose} onAdded={onAdded} />
      ) : (
        <UsbDiscovery onClose={onClose} onAdded={onAdded} />
      )}
    </FloatingWindow>
  );
}

// ---------------------------------------------------------------------------
// Descubrimiento de cámaras IP en la red
// ---------------------------------------------------------------------------
function IpDiscovery({ onClose, onAdded }) {
  const [hosts, setHosts] = useState(null); // null = escaneando
  const [scanError, setScanError] = useState(null);
  const [subnet, setSubnet] = useState(""); // subred escaneada (informativo)
  const [customSubnet, setCustomSubnet] = useState(""); // "192.168.50" red remota (opcional)
  const [selected, setSelected] = useState(null); // host elegido
  const [probe, setProbe] = useState(null); // resultado de la sonda
  const [probing, setProbing] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function scan() {
    setHosts(null);
    setScanError(null);
    setSelected(null);
    setProbe(null);
    try {
      // Si se indica una subred (p.ej. "192.168.50") escanea esa red remota.
      const cs = customSubnet.trim();
      const qs = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cs) ? `?subnet=${cs}` : "";
      const res = await fetch("/api/discover/network" + qs);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al escanear la red");
      setSubnet(data.subnet || "");
      setHosts(data.hosts || []);
    } catch (err) {
      setScanError(err.message);
      setHosts([]);
    }
  }
  useEffect(() => {
    scan();
  }, []);

  function choose(host) {
    if (host.inUse) return;
    setSelected(host);
    setProbe(null);
    setError(null);
    setName(`Cámara ${host.ip.split(".").pop()}`);
    // Lanza la sonda automáticamente sin credenciales (muchas no las piden).
    runProbe(host, "", "");
  }

  async function runProbe(host, u, p) {
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      const res = await fetch("/api/discover/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: host.ip, user: u, password: p }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al sondear");
      setProbe(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setProbing(false);
    }
  }

  async function handleAdd() {
    if (!probe?.found) return;
    if (!name.trim()) return setError("Pon un nombre a la cámara.");
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), rtsp: probe.rtsp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al añadir");
      onAdded(data.camera);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="discover-subnet">
        <label className="field field-sm">
          <span>Subred a escanear</span>
          <input
            value={customSubnet}
            onChange={(e) => setCustomSubnet(e.target.value)}
            placeholder="(auto: red local)"
            title="Déjalo vacío para la red local. Para una red remota (por VPN/Tailscale) escribe los 3 primeros octetos, p.ej. 192.168.50"
          />
        </label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={scan}>
          🔍 Escanear
        </button>
      </div>
      <div className="usb-scan-head">
        <span>
          Hosts en la red {subnet && <code>{subnet}</code>} con pinta de cámara:
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={scan}>
          ↻ Volver a escanear
        </button>
      </div>

      {hosts === null && <p className="banner-info">Escaneando la red…</p>}
      {scanError && <p className="modal-error">{scanError}</p>}
      {hosts?.length === 0 && !scanError && (
        <p className="banner-info">No se encontraron cámaras en la red.</p>
      )}

      <ul className="usb-device-list">
        {hosts?.map((h) => (
          <li key={h.ip}>
            <button
              type="button"
              className={
                "usb-device" +
                (selected?.ip === h.ip ? " usb-device-on" : "") +
                (h.inUse ? " usb-device-used" : "")
              }
              disabled={h.inUse}
              onClick={() => choose(h)}
            >
              <span className="usb-device-name">
                {h.likelyCamera ? "📷" : "❓"} {h.ip}
              </span>
              <span className="usb-device-meta">
                {h.inUse
                  ? "ya añadida"
                  : (h.onvif ? "ONVIF · " : "") + "puertos " + h.openPorts.join(", ")}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <div className="discover-probe">
          <h3 className="section-title">Sondeo de {selected.ip}</h3>

          {probing && (
            <p className="banner-info">
              <span className="spinner-inline" /> Probando rutas y credenciales
              RTSP… (puede tardar unos segundos)
            </p>
          )}

          {!probing && probe?.found && (
            <>
              <p className="discover-ok">
                ✅ Stream encontrado: <code>{probe.codec} {probe.width}×{probe.height}</code>
                <br />
                <span className="discover-rtsp">{maskRtsp(probe.rtsp)}</span>
              </p>
              <label className="field">
                <span>Nombre *</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </label>
            </>
          )}

          {!probing && probe && !probe.found && (
            <>
              <p className="modal-error">
                {probe.reason === "no-rtsp-port"
                  ? "No tiene puerto RTSP (554) abierto. Puede ser una cámara solo-nube (P2P), no integrable."
                  : `No se encontró un stream válido (probadas ${probe.tried} combinaciones). Prueba con usuario y contraseña:`}
              </p>
              {probe.reason !== "no-rtsp-port" && (
                <div className="field-row">
                  <label className="field">
                    <span>Usuario</span>
                    <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" />
                  </label>
                  <label className="field">
                    <span>Contraseña</span>
                    <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </div>
              )}
              {probe.reason !== "no-rtsp-port" && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => runProbe(selected, user, password)}
                >
                  Reintentar con estas credenciales
                </button>
              )}
            </>
          )}

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cerrar
            </button>
            {probe?.found && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAdd}
                disabled={submitting}
              >
                {submitting ? "Añadiendo…" : "Añadir cámara"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Oculta la contraseña en la URL RTSP que se muestra al usuario. */
function maskRtsp(rtsp) {
  return String(rtsp).replace(/(rtsp:\/\/[^:]*:)[^@]*(@)/, "$1•••$2");
}

// ---------------------------------------------------------------------------
// Descubrimiento de cámaras USB (DirectShow)
// ---------------------------------------------------------------------------
function UsbDiscovery({ onClose, onAdded }) {
  const [devices, setDevices] = useState(null);
  const [scanError, setScanError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [fps, setFps] = useState(15);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function scan() {
    setDevices(null);
    setScanError(null);
    setSelected(null);
    try {
      const res = await fetch("/api/usb-cameras/scan");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al escanear");
      setDevices(data.devices || []);
    } catch (err) {
      setScanError(err.message);
      setDevices([]);
    }
  }
  useEffect(() => {
    scan();
  }, []);

  function choose(dev) {
    if (dev.inUse) return;
    setSelected(dev);
    setError(null);
    setName(dev.device);
    const best = dev.formats?.[0];
    setSize(best ? best.size : "640x480");
    setFps(best ? Math.min(best.maxFps || 15, 15) : 15);
  }

  const sizeOptions = selected?.formats?.length
    ? selected.formats.map((f) => f.size)
    : ["640x480"];

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!selected) return setError("Elige una cámara de la lista.");
    if (!name.trim()) return setError("El nombre es obligatorio.");
    setSubmitting(true);
    try {
      const res = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          source: "usb",
          device: selected.device,
          size,
          fps: Number(fps),
          model: selected.device,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al añadir la cámara");
      onAdded(data.camera);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="usb-scan-head">
        <span>Webcams USB detectadas por Windows:</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={scan}>
          ↻ Volver a escanear
        </button>
      </div>

      {devices === null && <p className="banner-info">Escaneando…</p>}
      {scanError && <p className="modal-error">{scanError}</p>}
      {devices?.length === 0 && !scanError && (
        <p className="banner-info">No se detectó ninguna cámara USB.</p>
      )}

      <ul className="usb-device-list">
        {devices?.map((dev) => (
          <li key={dev.device}>
            <button
              type="button"
              className={
                "usb-device" +
                (selected?.device === dev.device ? " usb-device-on" : "") +
                (dev.inUse ? " usb-device-used" : "")
              }
              disabled={dev.inUse}
              onClick={() => choose(dev)}
            >
              <span className="usb-device-name">📷 {dev.device}</span>
              <span className="usb-device-meta">
                {dev.inUse
                  ? "ya añadida"
                  : dev.formats?.[0]
                    ? `hasta ${dev.formats[0].size} · ${dev.formats[0].maxFps} fps`
                    : "—"}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Nombre *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="field-row">
            <label className="field">
              <span>Resolución</span>
              <select value={size} onChange={(e) => setSize(e.target.value)}>
                {sizeOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="field field-sm">
              <span>FPS</span>
              <input
                type="number"
                min="1"
                max="60"
                value={fps}
                onChange={(e) => setFps(e.target.value)}
              />
            </label>
          </div>
          <p className="modal-hint">
            Si la imagen se ve a tirones, baja los fps. Se puede ajustar luego.
          </p>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Añadiendo…" : "Añadir cámara"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
