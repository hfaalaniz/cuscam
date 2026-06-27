import { useEffect, useRef, useState } from "react";

/**
 * Controles PTZ (Pan-Tilt-Zoom) para una cámara.
 * Mantén pulsado un botón para mover y suelta para detener
 * (move on press / stop on release), igual que un joystick. Mientras se
 * mantiene pulsado se reenvía el comando (keep-alive) para que la cámara no
 * se autodetenga por el timeout de seguridad ONVIF.
 */
export default function PtzControls({ cameraId, onZoomIn, onZoomOut }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const keepAlive = useRef(null);

  // Limpia el intervalo si el componente se desmonta mientras se mueve.
  useEffect(() => () => clearInterval(keepAlive.current), []);

  async function send(body) {
    try {
      const res = await fetch(`/api/cameras/${cameraId}/ptz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Error PTZ");
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }

  function startMove(direction) {
    setBusy(true);
    send({ direction, action: "move", speed: 0.6 });
    clearInterval(keepAlive.current);
    keepAlive.current = setInterval(
      () => send({ direction, action: "move", speed: 0.6 }),
      400
    );
  }

  function stopMove() {
    clearInterval(keepAlive.current);
    keepAlive.current = null;
    setBusy(false);
    send({ action: "stop" });
  }

  // Props comunes para botones tipo joystick (pulsar/soltar y soporte táctil).
  const press = (direction) => ({
    onMouseDown: () => startMove(direction),
    onMouseUp: stopMove,
    onMouseLeave: stopMove,
    onTouchStart: (e) => {
      e.preventDefault();
      startMove(direction);
    },
    onTouchEnd: (e) => {
      e.preventDefault();
      stopMove();
    },
  });

  return (
    <div className="ptz">
      <div className="ptz-pad">
        <button className="ptz-btn ptz-up" title="Arriba" {...press("up")}>▲</button>
        <button className="ptz-btn ptz-left" title="Izquierda" {...press("left")}>◀</button>
        <span className="ptz-center" />
        <button className="ptz-btn ptz-right" title="Derecha" {...press("right")}>▶</button>
        <button className="ptz-btn ptz-down" title="Abajo" {...press("down")}>▼</button>
      </div>

      <div className="ptz-zoom">
        <button
          className="ptz-btn"
          title="Acercar (zoom digital +)"
          onClick={onZoomIn}
        >
          ＋
        </button>
        <button
          className="ptz-btn"
          title="Alejar (zoom digital −)"
          onClick={onZoomOut}
        >
          －
        </button>
      </div>

      {error && <div className="ptz-error" title={error}>⚠ PTZ</div>}
    </div>
  );
}
