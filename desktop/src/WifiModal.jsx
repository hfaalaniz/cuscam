import { useEffect, useState } from "react";
import PasswordInput from "./PasswordInput.jsx";

/**
 * Modal para configurar el Wi-Fi de una cámara (SSID + contraseña).
 *
 * IMPORTANTE: el streaming RTSP no permite reconfigurar el Wi-Fi de la cámara.
 * Este modal guarda los datos como REFERENCIA en config/cameras.json y muestra
 * los pasos para aplicarlos realmente mediante la app oficial V380.
 */
export default function WifiModal({ camera, onClose, onSaved }) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`/api/cameras/${camera.id}/wifi`)
      .then((res) => res.json())
      .then((data) => {
        setSsid(data.wifi?.ssid || "");
        setPassword(data.wifi?.password || "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [camera.id]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cameras/${camera.id}/wifi`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error al guardar");
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Wi-Fi de la cámara — {camera.name}</h2>

        <div className="notice">
          ⚠️ Por seguridad, las cámaras V380 no permiten cambiar su Wi-Fi por la red
          de video. Estos datos se guardan como <strong>referencia</strong>. Para
          aplicarlos de verdad, sigue los pasos de abajo en la app oficial V380.
        </div>

        {loading ? (
          <p className="banner-info">Cargando…</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="field">
              <span>Nombre de red (SSID)</span>
              <input
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder="MiRedWiFi"
                autoFocus
              />
            </label>

            <label className="field">
              <span>Contraseña Wi-Fi</span>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {error && <p className="modal-error">{error}</p>}

            <details className="steps">
              <summary>Cómo aplicar el Wi-Fi en la cámara (app V380)</summary>
              <ol>
                <li>Abre la app <strong>V380 Pro</strong> en tu teléfono.</li>
                <li>Selecciona la cámara → <em>Configuración</em> (icono de engranaje).</li>
                <li>Entra en <em>Configuración de red / Wi-Fi</em>.</li>
                <li>Elige la red <strong>{ssid || "(tu red)"}</strong> e ingresa la contraseña.</li>
                <li>Confirma; la cámara se reiniciará y se conectará al nuevo Wi-Fi.</li>
              </ol>
            </details>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cerrar
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? "Guardando…" : "Guardar referencia"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
