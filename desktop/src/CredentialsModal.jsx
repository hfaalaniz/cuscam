import { useState } from "react";
import PasswordInput from "./PasswordInput.jsx";
import FloatingWindow from "./FloatingWindow.jsx";

/**
 * Modal para ingresar/actualizar el usuario y contraseña RTSP de una cámara.
 * Envía PATCH /api/cameras/:id/credentials; el backend reescribe la URL RTSP.
 */
export default function CredentialsModal({ camera, onClose, onSaved }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cameras/${camera.id}/credentials`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
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
    <FloatingWindow title={`Credenciales RTSP — ${camera.name}`} onClose={onClose}>

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Usuario</span>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="admin"
              autoFocus
            />
          </label>

          <label className="field">
            <span>Contraseña</span>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && <p className="modal-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </form>
    </FloatingWindow>
  );
}
