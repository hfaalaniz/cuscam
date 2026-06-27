import { useEffect, useState } from "react";

/**
 * Modal con el historial de pérdidas/recuperaciones de señal de una cámara,
 * leído del log de MediaMTX (GET /api/cameras/:id/signal-events). Las pérdidas
 * son cortes reales del origen RTSP (EOF, TCP timeout, conexión reseteada…),
 * la fuente más fiable de calidad de enlace.
 */
export default function SignalHistoryModal({ camera, onClose }) {
  const [events, setEvents] = useState([]);
  const [totalLosses, setTotalLosses] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let aborted = false;
    fetch(`/api/cameras/${camera.id}/signal-events`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar");
        return json;
      })
      .then((json) => {
        if (aborted) return;
        setEvents(json.events || []);
        setTotalLosses(json.totalLosses || 0);
      })
      .catch((err) => !aborted && setError(err.message))
      .finally(() => !aborted && setLoading(false));
    return () => {
      aborted = true;
    };
  }, [camera.id]);

  const fmt = (ms) => new Date(ms).toLocaleString();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Historial de señal — {camera.name}</h2>

        {loading && <p className="banner-info">Cargando historial…</p>}
        {error && <p className="modal-error">{error}</p>}

        {!loading && !error && (
          <>
            <p className="modal-hint">
              <strong>{totalLosses}</strong> pérdida(s) de señal registradas
              {events.length >= 200 ? " (mostrando las más recientes)" : ""}. Datos
              del log de MediaMTX (cortes reales del origen RTSP).
            </p>

            {events.length === 0 ? (
              <p className="modal-hint">
                No hay eventos de señal registrados para esta cámara. 👍
              </p>
            ) : (
              <div className="rec-list">
                <table className="caps-table">
                  <thead>
                    <tr>
                      <th>Fecha y hora</th>
                      <th>Evento</th>
                      <th>Detalle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e, i) => (
                      <tr key={i}>
                        <td>{fmt(e.at)}</td>
                        <td>
                          {e.type === "loss" ? (
                            <span className="sig-loss">⚠ Pérdida</span>
                          ) : (
                            <span className="sig-online">✓ Recuperada</span>
                          )}
                        </td>
                        <td className="rec-name">{e.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
