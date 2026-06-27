import { useEffect, useState } from "react";

/**
 * Modal para configurar la red: IP del host Windows (donde corre MediaMTX)
 * y el puerto HLS. Estos valores definen las URLs de salida de todas las cámaras.
 * Lee/escribe vía GET/PUT /api/network.
 */
export default function NetworkModal({ onClose, onSaved }) {
  const [windowsHostIp, setWindowsHostIp] = useState("");
  const [hlsPort, setHlsPort] = useState("8888");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/network")
      .then((res) => res.json())
      .then((data) => {
        setWindowsHostIp(data.windowsHostIp || "");
        setHlsPort(String(data.hlsPort || 8888));
      })
      .catch(() => setError("No se pudo cargar la configuración de red."))
      .finally(() => setLoading(false));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!windowsHostIp.trim()) {
      setError("La IP del host es obligatoria.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/network", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowsHostIp, hlsPort: Number(hlsPort) }),
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
        <h2 className="modal-title">Configuración de red</h2>

        {loading ? (
          <p className="banner-info">Cargando…</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="field">
              <span>IP del host Windows (servidor MediaMTX)</span>
              <input
                value={windowsHostIp}
                onChange={(e) => setWindowsHostIp(e.target.value)}
                placeholder="192.168.1.15"
                autoFocus
              />
            </label>

            <label className="field field-sm">
              <span>Puerto HLS</span>
              <input
                value={hlsPort}
                onChange={(e) => setHlsPort(e.target.value)}
              />
            </label>

            <p className="modal-hint">
              Cambiar estos valores actualiza las URLs de todas las cámaras.
            </p>

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
        )}
      </div>
    </div>
  );
}
