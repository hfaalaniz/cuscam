import { useCallback, useEffect, useState } from "react";
import PtzControls from "./PtzControls.jsx";
import HlsVideo from "./HlsVideo.jsx";
import WebrtcPlayer from "./WebrtcPlayer.jsx";

/**
 * Modal de cámara ampliada. Reproduce la misma cámara en grande con el modo
 * actual (WebRTC/HLS), control PTZ y zoom digital. Se cierra con Esc o el botón.
 */
export default function ExpandedCameraModal({ camera, mode = "hls", onClose }) {
  const [status, setStatus] = useState("loading");
  const [fellBack, setFellBack] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [audioOn, setAudioOn] = useState(false);

  const useWebrtc = mode === "webrtc" && camera.webrtcUrl && !fellBack;

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.25;
  const zoomIn = useCallback(
    () => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2))),
    []
  );
  const zoomOut = useCallback(
    () => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2))),
    []
  );

  // Envío de comandos PTZ al backend (compartido por botones y teclado).
  const sendPtz = useCallback(
    (body) =>
      fetch(`/api/cameras/${camera.id}/ptz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => console.warn("PTZ:", err)),
    [camera.id]
  );

  const handleStatus = useCallback(
    (s) => {
      if (s === "error" && mode === "webrtc" && !fellBack) {
        setFellBack(true);
        setStatus("loading");
        return;
      }
      setStatus(s);
    },
    [mode, fellBack]
  );

  // Control por teclado de la cámara ampliada:
  //  · Esc      -> cerrar
  //  · Flechas  -> PAN/TILT (mover al pulsar, detener al soltar)
  //  · +/-      -> zoom digital
  useEffect(() => {
    const ARROWS = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    let moving = null;
    let keepAlive = null;

    const typing = (t) =>
      t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    // Movimiento continuo con keep-alive (reenvía el comando mientras se pulsa,
    // para que la cámara no se autodetenga por el timeout de seguridad ONVIF).
    function startMoving(dir) {
      moving = dir;
      sendPtz({ direction: dir, action: "move", speed: 0.6 });
      clearInterval(keepAlive);
      keepAlive = setInterval(
        () => sendPtz({ direction: dir, action: "move", speed: 0.6 }),
        400
      );
    }
    function stopMoving() {
      if (!moving) return;
      moving = null;
      clearInterval(keepAlive);
      keepAlive = null;
      sendPtz({ action: "stop" });
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (typing(e.target)) return;

      const dir = ARROWS[e.key];
      if (dir) {
        e.preventDefault();
        if (e.repeat) return;
        if (moving !== dir) startMoving(dir);
        return;
      }

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      }
    }

    function onKeyUp(e) {
      if (ARROWS[e.key] && ARROWS[e.key] === moving) stopMoving();
    }

    function onBlur() {
      stopMoving();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      clearInterval(keepAlive);
    };
  }, [onClose, sendPtz, zoomIn, zoomOut]);

  // Ctrl + rueda del ratón = zoom. Mientras el modal está abierto capturamos
  // el evento en `window` (no pasivo) para impedir SIEMPRE el zoom del
  // navegador, sin importar sobre qué parte del modal esté el puntero.
  useEffect(() => {
    const handler = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, [zoomIn, zoomOut]);

  return (
    <div className="modal-backdrop expanded-backdrop" onClick={onClose}>
      <div className="expanded-modal" onClick={(e) => e.stopPropagation()}>
        <div className="expanded-header">
          <span className="expanded-title">
            {camera.name}
            <span className="mode-badge">{useWebrtc ? "WebRTC" : "HLS"}</span>
          </span>
          <button
            className={"card-action" + (audioOn ? " card-action-on" : "")}
            title={audioOn ? "Silenciar audio" : "Activar audio"}
            onClick={() => setAudioOn((v) => !v)}
          >
            {audioOn ? "🔊" : "🔇"}
          </button>
          <button className="card-action card-delete" title="Cerrar" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="expanded-video">
          <div className="video-zoom" style={{ transform: `scale(${zoom})` }}>
            {useWebrtc ? (
              <WebrtcPlayer key="wrtc" url={camera.webrtcUrl} name={camera.name} onStatus={handleStatus} muted={!audioOn} />
            ) : (
              <HlsVideo key="hls" url={camera.url} name={camera.name} onStatus={handleStatus} muted={!audioOn} />
            )}
          </div>
          {status === "loading" && <div className="overlay spinner" />}
          {status === "error" && <div className="overlay error">Sin señal</div>}
          {zoom > 1 && <div className="zoom-badge">{zoom.toFixed(2)}×</div>}

          <div className="ptz-overlay">
            <PtzControls cameraId={camera.id} onZoomIn={zoomIn} onZoomOut={zoomOut} />
          </div>
        </div>
      </div>
    </div>
  );
}
