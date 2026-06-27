import { useState } from "react";
import PasswordInput from "./PasswordInput.jsx";
import FloatingWindow from "./FloatingWindow.jsx";

const EMPTY = {
  name: "",
  ip: "",
  port: "554",
  path: "/live/ch00_1",
  user: "",
  password: "",
  deviceId: "",
  model: "",
};

/**
 * Modal para añadir una cámara nueva. Envía los datos al backend (POST /api/cameras).
 * El backend construye la URL RTSP y persiste en config/cameras.json.
 */
export default function AddCameraModal({ onClose, onAdded }) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const update = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!form.name.trim() || !form.ip.trim()) {
      setError("El nombre y la IP son obligatorios.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
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
    <FloatingWindow title="Agregar cámara" onClose={onClose}>

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Nombre *</span>
            <input
              value={form.name}
              onChange={update("name")}
              placeholder="Cámara Entrada"
              autoFocus
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>IP *</span>
              <input
                value={form.ip}
                onChange={update("ip")}
                placeholder="192.168.1.34"
              />
            </label>
            <label className="field field-sm">
              <span>Puerto</span>
              <input value={form.port} onChange={update("port")} />
            </label>
          </div>

          <label className="field">
            <span>Ruta del stream RTSP</span>
            <input
              value={form.path}
              onChange={update("path")}
              placeholder="/live/ch00_1"
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Usuario</span>
              <input
                value={form.user}
                onChange={update("user")}
                placeholder="admin"
              />
            </label>
            <label className="field">
              <span>Contraseña</span>
              <PasswordInput
                value={form.password}
                onChange={update("password")}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>ID Dispositivo</span>
              <input
                value={form.deviceId}
                onChange={update("deviceId")}
                placeholder="117809832"
              />
            </label>
            <label className="field">
              <span>Modelo</span>
              <input
                value={form.model}
                onChange={update("model")}
                placeholder="A2X1EXHR"
              />
            </label>
          </div>

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Guardando…" : "Agregar"}
            </button>
          </div>
        </form>
    </FloatingWindow>
  );
}
