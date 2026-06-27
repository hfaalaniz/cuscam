import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

/**
 * Reproductor HLS de baja latencia. Usa hls.js donde no hay HLS nativo
 * (Chrome/Edge/Firefox) y cae al soporte nativo del <video> en Safari.
 *
 * Auto-recuperación: las cámaras RTSP cortan la conexión a menudo (EOF/timeout),
 * y entonces MediaMTX destruye y recrea el muxer HLS. En vez de quedarnos en
 * "Sin señal" para siempre, ante un error fatal reintentamos cargar el stream
 * con backoff hasta que el muxer vuelve a estar disponible. Los errores no
 * fatales se intentan recuperar en caliente sin reiniciar.
 */
export default function HlsVideo({ url, name, onStatus, onReconnect, muted = true }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("loading");

  // Aplica mute/unmute en tiempo real sobre el elemento <video>.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls;
    let destroyed = false; // el efecto se está limpiando (desmontaje/cambio de url)
    let retryTimer = null;
    let retryDelay = 1000; // backoff: 1s, 2s, 4s… hasta MAX
    const MAX_DELAY = 10000;

    setStatus("loading");
    onStatus?.("loading");

    const onPlaying = () => {
      retryDelay = 1000; // el stream se recuperó: reseteamos el backoff
      setStatus("playing");
      onStatus?.("playing");
    };
    video.addEventListener("playing", onPlaying);

    // Programa un reintento del stream tras un fallo fatal (con backoff).
    // Mientras tanto seguimos en "loading" (spinner), no en "error", porque
    // la cámara casi siempre vuelve en unos segundos.
    const scheduleRetry = (reason) => {
      if (destroyed) return;
      console.warn(`HLS ${name}: ${reason} — reintentando en ${retryDelay}ms`);
      onReconnect?.(reason); // contabiliza la pérdida de señal (calidad de enlace)
      setStatus("loading");
      onStatus?.("loading");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (destroyed) return;
        retryDelay = Math.min(MAX_DELAY, retryDelay * 2);
        start();
      }, retryDelay);
    };

    const start = () => {
      if (destroyed) return;

      if (Hls.isSupported()) {
        // Si reintentamos, descartamos la instancia anterior antes de recrear.
        if (hls) {
          hls.destroy();
          hls = null;
        }
        hls = new Hls({
          lowLatencyMode: true,
          liveSyncDuration: 0.6,
          liveMaxLatencyDuration: 2,
          maxLiveSyncPlaybackRate: 1.5,
          maxBufferLength: 3,
          backBufferLength: 4,
          liveDurationInfinity: true,
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.FRAG_LOADED, () => {
          if (hls.liveSyncPosition != null) {
            const gap = hls.liveSyncPosition - video.currentTime;
            if (gap > 3) video.currentTime = hls.liveSyncPosition;
          }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // Errores fatales recuperables en caliente (sin recrear la instancia).
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.warn(`HLS ${name}: media error fatal, recoverMediaError()`);
            try {
              hls.recoverMediaError();
              return;
            } catch {
              /* cae a reintento completo */
            }
          }
          // Error de red (muxer destruido/404, EOF de la cámara…): recreamos.
          scheduleRetry(`${data.type} ${data.details}`);
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.onerror = () => scheduleRetry("native error");
        video.load();
      } else {
        setStatus("error");
        onStatus?.("error");
      }
    };

    start();

    return () => {
      destroyed = true;
      clearTimeout(retryTimer);
      video.removeEventListener("playing", onPlaying);
      video.onerror = null;
      if (hls) hls.destroy();
    };
  }, [url, name, onStatus, onReconnect]);

  return (
    <video
      ref={videoRef}
      className="video"
      muted={muted}
      autoPlay
      playsInline
      controls={false}
      data-status={status}
    />
  );
}
