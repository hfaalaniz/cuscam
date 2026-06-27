import { useEffect, useState } from "react";
import PasswordInput from "./PasswordInput.jsx";

/**
 * Modal para editar TODAS las propiedades de una cámara que expone el backend:
 * nombre, ID dispositivo, modelo, IP/puerto/ruta/usuario/contraseña RTSP y Wi-Fi.
 * Lee con GET /api/cameras/:id/full y guarda con PUT /api/cameras/:id.
 */
export default function EditCameraModal({ camera, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/cameras/${camera.id}/full`)
      .then((res) => res.json())
      .then((data) => {
        const c = data.camera;
        setForm({
          name: c.name || "",
          deviceId: c.deviceId || "",
          model: c.model || "",
          ip: c.ip || "",
          port: c.port || "554",
          path: c.path || "/live/ch00_1",
          user: c.user || "",
          password: c.password || "",
          onvifPort: c.onvifPort || 8899,
          wifiSsid: c.wifi?.ssid || "",
          wifiPassword: c.wifi?.password || "",
        });
      })
      .catch(() => setError("No se pudo cargar la cámara."))
      .finally(() => setLoading(false));
  }, [camera.id]);

  const update = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cameras/${camera.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          deviceId: form.deviceId,
          model: form.model,
          ip: form.ip,
          port: form.port,
          path: form.path,
          user: form.user,
          password: form.password,
          onvifPort: form.onvifPort,
          wifi: { ssid: form.wifiSsid, password: form.wifiPassword },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al guardar");
      onSaved(data.camera);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Editar cámara</h2>

        {loading || !form ? (
          <p className="banner-info">Cargando…</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <h3 className="section-title">General</h3>
            <label className="field">
              <span>Nombre *</span>
              <input value={form.name} onChange={update("name")} autoFocus />
            </label>
            <div className="field-row">
              <label className="field">
                <span>ID Dispositivo</span>
                <input value={form.deviceId} onChange={update("deviceId")} />
              </label>
              <label className="field">
                <span>Modelo</span>
                <input value={form.model} onChange={update("model")} />
              </label>
            </div>

            <h3 className="section-title">Conexión RTSP</h3>
            <div className="field-row">
              <label className="field">
                <span>IP</span>
                <input value={form.ip} onChange={update("ip")} placeholder="192.168.1.34" />
              </label>
              <label className="field field-sm">
                <span>Puerto</span>
                <input value={form.port} onChange={update("port")} />
              </label>
            </div>
            <label className="field">
              <span>Ruta del stream</span>
              <input value={form.path} onChange={update("path")} placeholder="/live/ch00_1" />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Usuario</span>
                <input value={form.user} onChange={update("user")} placeholder="admin" />
              </label>
              <label className="field">
                <span>Contraseña</span>
                <PasswordInput value={form.password} onChange={update("password")} />
              </label>
            </div>

            <h3 className="section-title">Control PTZ (ONVIF)</h3>
            <label className="field field-sm">
              <span>Puerto ONVIF</span>
              <input
                value={form.onvifPort}
                onChange={update("onvifPort")}
                placeholder="8899"
              />
            </label>

            <h3 className="section-title">Wi-Fi (referencia)</h3>
            <div className="field-row">
              <label className="field">
                <span>SSID</span>
                <input value={form.wifiSsid} onChange={update("wifiSsid")} />
              </label>
              <label className="field">
                <span>Contraseña Wi-Fi</span>
                <PasswordInput value={form.wifiPassword} onChange={update("wifiPassword")} />
              </label>
            </div>

            {error && <p className="modal-error">{error}</p>}

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
