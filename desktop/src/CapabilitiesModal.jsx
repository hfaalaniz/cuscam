import { useEffect, useState } from "react";
import FloatingWindow from "./FloatingWindow.jsx";

/**
 * Modal que consulta y muestra las capacidades reales de la cámara por ONVIF:
 * información del dispositivo, soporte PTZ y perfiles de video disponibles.
 * Lee de GET /api/cameras/:id/capabilities.
 */
export default function CapabilitiesModal({ camera, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let aborted = false;
    fetch(`/api/cameras/${camera.id}/capabilities`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar");
        return json;
      })
      .then((json) => !aborted && setData(json))
      .catch((err) => !aborted && setError(err.message))
      .finally(() => !aborted && setLoading(false));
    return () => {
      aborted = true;
    };
  }, [camera.id]);

  const yn = (v) => (v ? "✅ Sí" : "❌ No");

  return (
    <FloatingWindow title={`Capacidades ONVIF — ${camera.name}`} onClose={onClose} wide>
        {loading && <p className="banner-info">Consultando la cámara…</p>}
        {error && <p className="modal-error">{error}</p>}

        {data && (
          <>
            <h3 className="section-title">Dispositivo</h3>
            {data.device ? (
              <table className="caps-table">
                <tbody>
                  <tr><td>Fabricante</td><td>{data.device.manufacturer ?? "—"}</td></tr>
                  <tr><td>Modelo</td><td>{data.device.model ?? "—"}</td></tr>
                  <tr><td>Firmware</td><td>{String(data.device.firmware ?? "—")}</td></tr>
                  <tr><td>N.º de serie</td><td>{String(data.device.serial ?? "—")}</td></tr>
                  <tr><td>Hardware ID</td><td>{String(data.device.hardwareId ?? "—")}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className="modal-hint">El dispositivo no expuso esta información.</p>
            )}

            <h3 className="section-title">Control PTZ</h3>
            <table className="caps-table">
              <tbody>
                <tr><td>PTZ soportado</td><td>{yn(data.ptz.supported)}</td></tr>
                <tr><td>Giro horizontal (pan)</td><td>{yn(data.ptz.pan)}</td></tr>
                <tr><td>Inclinación (tilt)</td><td>{yn(data.ptz.tilt)}</td></tr>
                <tr><td>Zoom</td><td>{yn(data.ptz.zoom)}</td></tr>
              </tbody>
            </table>
            {data.ptz.zoom && (
              <p className="modal-hint">
                Nota: el zoom puede estar declarado por ONVIF aunque la cámara
                no tenga zoom óptico real (lente fija).
              </p>
            )}

            <h3 className="section-title">Perfiles de video</h3>
            {data.videoProfiles.length ? (
              <table className="caps-table">
                <thead>
                  <tr><th>Perfil</th><th>Códec</th><th>Resolución</th><th>FPS</th><th>Bitrate</th></tr>
                </thead>
                <tbody>
                  {data.videoProfiles.map((p) => (
                    <tr key={p.name}>
                      <td>{p.name}</td>
                      <td>{p.codec || "—"}</td>
                      <td>{p.width && p.height ? `${p.width}×${p.height}` : "—"}</td>
                      <td>{p.fps ?? "—"}</td>
                      <td>{p.bitrate ? `${p.bitrate} kbps` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="modal-hint">La cámara no expuso perfiles de video.</p>
            )}
          </>
        )}

    </FloatingWindow>
  );
}
