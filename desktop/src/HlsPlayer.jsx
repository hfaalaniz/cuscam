import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import PtzControls from "./PtzControls.jsx";
import HlsVideo from "./HlsVideo.jsx";
import WebrtcPlayer from "./WebrtcPlayer.jsx";

// Modo de prueba: ?debugLink=N fuerza el contador de reconexiones a N para ver
// el badge de calidad de enlace sin esperar a un corte real (0 si no se indica).
const DEBUG_LINK = (() => {
  const n = Number(new URLSearchParams(window.location.search).get("debugLink"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
})();

/**
 * Tarjeta de una cámara: barra de acciones + reproductor + PTZ.
 * Según `mode` reproduce con WebRTC (tiempo casi real) o HLS (~1-2s).
 * Si WebRTC falla, cae automáticamente a HLS.
 */
const HlsPlayer = forwardRef(function HlsPlayer(
  {
    cameraId,
    url, // URL HLS
    webrtcUrl, // URL WebRTC/WHEP
    name,
    source = "rtsp", // "usb" (webcam DirectShow) | "rtsp" (IP/V380)
    mode = "hls", // "webrtc" | "hls"
    quality = "low", // "high" (720p) | "low" (360p)
    switching = false, // true mientras se cambia la calidad
    active = false, // ventana seleccionada para control por teclado
    recording = false, // true si esta cámara está grabando
    audioOn = false, // audio de esta cámara activo (exclusivo, controlado por App)
    onToggleAudio,
    onActivate,
    onToggleQuality,
    onEdit,
    onCapabilities,
    onRecordings,
    onSignalHistory,
    onDelete,
    onCredentials,
    onWifi,
    onExpand,
    onHide, // cerrar la ventana (ocultar, sin eliminar la cámara)
  },
  ref
) {
  const [status, setStatus] = useState("loading");
  const [showPtz, setShowPtz] = useState(false);
  const [fellBack, setFellBack] = useState(false); // WebRTC -> HLS
  const [zoom, setZoom] = useState(1); // zoom digital (escala CSS del video)
  // nº de pérdidas de señal (calidad de enlace). Con ?debugLink=N en la URL se
  // arranca con N para poder ver el badge sin esperar a un corte real.
  const [reconnects, setReconnects] = useState(DEBUG_LINK);
  const [lastDrop, setLastDrop] = useState(DEBUG_LINK > 0 ? new Date() : null); // hora de la última caída

  // Cada pérdida de señal incrementa el contador (indicador de enlace Wi-Fi).
  const handleReconnect = useCallback(() => {
    setReconnects((n) => n + 1);
    setLastDrop(new Date());
  }, []);

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
      fetch(`/api/cameras/${cameraId}/ptz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => console.warn("PTZ:", err)),
    [cameraId]
  );

  // Expone a App.jsx las acciones de la ventana activa (teclado/rueda).
  useImperativeHandle(
    ref,
    () => ({
      zoomIn,
      zoomOut,
      moveStart: (direction) => sendPtz({ direction, action: "move", speed: 0.6 }),
      moveStop: () => sendPtz({ action: "stop" }),
    }),
    [zoomIn, zoomOut, sendPtz]
  );

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

  // Ctrl + rueda del ratón = zoom de esta ventana. Se registra como listener
  // nativo no pasivo para poder cancelar el zoom de la página con preventDefault.
  const videoRef = useRef(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const handler = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      onActivate?.();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [onActivate, zoomIn, zoomOut]);

  return (
    <div
      className={"card" + (active ? " card-active" : "")}
      onMouseDown={onActivate}
    >
      <div className="card-header">
        <span className="card-title">
          {name}
          <span className="mode-badge">{useWebrtc ? "WebRTC" : "HLS"}</span>
          {reconnects > 0 && (
            <button
              type="button"
              className={
                "link-badge" +
                (reconnects >= 5 ? " link-bad" : reconnects >= 2 ? " link-warn" : "")
              }
              title={
                `${reconnects} reconexión(es) — pérdidas de señal` +
                (lastDrop ? `. Última: ${lastDrop.toLocaleTimeString()}` : "") +
                ". Click para ver el historial."
              }
              onClick={(e) => {
                e.stopPropagation();
                onSignalHistory?.();
              }}
            >
              ↻ {reconnects}
            </button>
          )}
          {recording && (
            <span className="rec-badge" title="Grabación continua activa">
              <span className="rec-dot" /> REC
            </span>
          )}
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
          <button
            className={"card-action" + (audioOn ? " card-action-on" : "")}
            title={
              !useWebrtc
                ? "Sin audio en modo HLS — cambia a WebRTC para escuchar"
                : audioOn
                ? "Silenciar audio"
                : "Activar audio (silencia las demás)"
            }
            onClick={onToggleAudio}
            disabled={!useWebrtc}
          >
            {useWebrtc ? (audioOn ? "🔊" : "🔇") : "🔇"}
          </button>
          {onRecordings && (
            <button className="card-action" title="Ver grabaciones" onClick={onRecordings}>
              ⏺
            </button>
          )}
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
              🗑
            </button>
          )}
          {onHide && (
            <button
              className="card-action card-close"
              title="Cerrar ventana (reábrela desde “Ventanas”)"
              onClick={onHide}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div
        ref={videoRef}
        className={"video-container" + (onExpand ? " expandable" : "")}
        onDoubleClick={onExpand}
        title={onExpand ? "Doble click para ampliar" : undefined}
      >
        <div
          className="video-zoom"
          style={{ transform: `scale(${zoom})` }}
        >
          {useWebrtc ? (
            <WebrtcPlayer
              key="wrtc"
              url={webrtcUrl}
              name={name}
              onStatus={handleStatus}
              onReconnect={handleReconnect}
              muted={!audioOn}
            />
          ) : (
            <HlsVideo
              key="hls"
              url={url}
              name={name}
              onStatus={handleStatus}
              onReconnect={handleReconnect}
              muted={!audioOn}
            />
          )}
        </div>
        {status === "loading" && !switching && <div className="overlay spinner" />}
        {status === "reconnecting" && !switching && (
          <div className="overlay switching">
            <div className="spinner-inline" />
            Conectando…
          </div>
        )}
        {status === "error" && !switching && (
          <div className="overlay error">
            {source === "usb" ? (
              <>
                <span className="overlay-icon">🔌</span>
                Cámara desconectada
              </>
            ) : (
              <>
                <span className="overlay-icon">📡</span>
                Sin señal
              </>
            )}
          </div>
        )}
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
});

export default HlsPlayer;
