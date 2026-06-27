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

  const useWebrtc = mode === "webrtc" && camera.webrtcUrl && !fellBack;

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.25;
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));

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

  // Cerrar con la tecla Escape.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop expanded-backdrop" onClick={onClose}>
      <div className="expanded-modal" onClick={(e) => e.stopPropagation()}>
        <div className="expanded-header">
          <span className="expanded-title">
            {camera.name}
            <span className="mode-badge">{useWebrtc ? "WebRTC" : "HLS"}</span>
          </span>
          <button className="card-action card-delete" title="Cerrar" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="expanded-video">
          <div className="video-zoom" style={{ transform: `scale(${zoom})` }}>
            {useWebrtc ? (
              <WebrtcPlayer key="wrtc" url={camera.webrtcUrl} name={camera.name} onStatus={handleStatus} />
            ) : (
              <HlsVideo key="hls" url={camera.url} name={camera.name} onStatus={handleStatus} />
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
