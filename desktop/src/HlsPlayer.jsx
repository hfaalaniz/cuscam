import { useCallback, useState } from "react";
import PtzControls from "./PtzControls.jsx";
import HlsVideo from "./HlsVideo.jsx";
import WebrtcPlayer from "./WebrtcPlayer.jsx";

/**
 * Tarjeta de una cámara: barra de acciones + reproductor + PTZ.
 * Según `mode` reproduce con WebRTC (tiempo casi real) o HLS (~1-2s).
 * Si WebRTC falla, cae automáticamente a HLS.
 */
export default function HlsPlayer({
  cameraId,
  url, // URL HLS
  webrtcUrl, // URL WebRTC/WHEP
  name,
  mode = "hls", // "webrtc" | "hls"
  quality = "low", // "high" (720p) | "low" (360p)
  switching = false, // true mientras se cambia la calidad
  onToggleQuality,
  onEdit,
  onCapabilities,
  onDelete,
  onCredentials,
  onWifi,
  onExpand,
}) {
  const [status, setStatus] = useState("loading");
  const [showPtz, setShowPtz] = useState(false);
  const [fellBack, setFellBack] = useState(false); // WebRTC -> HLS
  const [zoom, setZoom] = useState(1); // zoom digital (escala CSS del video)

  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.25;
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)));

  const useWebrtc = mode === "webrtc" && webrtcUrl && !fellBack;

  const handleStatus = useCallback(
    (s) => {
      // Si WebRTC falla, intentamos HLS automáticamente.
      if (s === "error" && mode === "webrtc" && !fellBack) {
        console.warn(`WebRTC falló en ${name}, cayendo a HLS`);
        setFellBack(true);
        setStatus("loading");
        return;
      }
      setStatus(s);
    },
    [mode, fellBack, name]
  );

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">
          {name}
          <span className="mode-badge">{useWebrtc ? "WebRTC" : "HLS"}</span>
        </span>
        <div className="card-actions">
          {onToggleQuality && (
            <button
              className={"card-action quality-btn" + (quality === "high" ? " quality-hd" : "")}
              title={
                quality === "high"
                  ? "Calidad: 720p (HD). Click para cambiar a 360p"
                  : "Calidad: 360p (SD). Click para cambiar a 720p"
              }
              onClick={onToggleQuality}
              disabled={switching}
            >
              {switching ? "…" : quality === "high" ? "HD" : "SD"}
            </button>
          )}
          <button
            className={"card-action" + (showPtz ? " card-action-on" : "")}
            title="Control PTZ (mover cámara)"
            onClick={() => setShowPtz((v) => !v)}
          >
            🕹️
          </button>
          {onEdit && (
            <button className="card-action" title="Editar todas las propiedades" onClick={onEdit}>
              ✏️
            </button>
          )}
          {onCapabilities && (
            <button className="card-action" title="Ver capacidades (ONVIF)" onClick={onCapabilities}>
              ℹ️
            </button>
          )}
          {onWifi && (
            <button className="card-action" title="Wi-Fi de la cámara" onClick={onWifi}>
              📶
            </button>
          )}
          {onCredentials && (
            <button className="card-action" title="Credenciales RTSP" onClick={onCredentials}>
              🔑
            </button>
          )}
          {onDelete && (
            <button className="card-action card-delete" title="Eliminar cámara" onClick={onDelete}>
              ✕
            </button>
          )}
        </div>
      </div>
      <div
        className={"video-container" + (onExpand ? " expandable" : "")}
        onDoubleClick={onExpand}
        title={onExpand ? "Doble click para ampliar" : undefined}
      >
        <div
          className="video-zoom"
          style={{ transform: `scale(${zoom})` }}
        >
          {useWebrtc ? (
            <WebrtcPlayer key="wrtc" url={webrtcUrl} name={name} onStatus={handleStatus} />
          ) : (
            <HlsVideo key="hls" url={url} name={name} onStatus={handleStatus} />
          )}
        </div>
        {status === "loading" && !switching && <div className="overlay spinner" />}
        {status === "error" && !switching && <div className="overlay error">Sin señal</div>}
        {switching && (
          <div className="overlay switching">
            <div className="spinner-inline" />
            Cambiando calidad…
          </div>
        )}
        {zoom > 1 && <div className="zoom-badge">{zoom.toFixed(2)}×</div>}
        {showPtz && (
          <div className="ptz-overlay">
            <PtzControls
              cameraId={cameraId}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
            />
          </div>
        )}
      </div>
    </div>
  );
}
