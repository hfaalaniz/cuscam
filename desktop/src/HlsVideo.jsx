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
    // Reintentos fallidos seguidos sin volver a reproducir. Pasado el umbral
    // dejamos de mostrar "reconectando" (spinner) y damos la cámara por caída
    // ("error" -> overlay "Sin señal"/"Cámara desconectada"). Un corte breve de
    // una V380 se recupera antes de llegar al umbral; una webcam USB
    // desconectada nunca recupera y mostrará el mensaje a los ~pocos segundos.
    let failStreak = 0;
    const FAIL_THRESHOLD = 3; // 1s + 2s + 4s ≈ 7s antes de declarar "caída"

    setStatus("loading");
    onStatus?.("loading");

    // Marca la cámara como "con imagen" en cuanto hay un frame listo. No basta
    // con el evento "playing": en algunas cámaras (sub-stream con GOP largo)
    // tarda en dispararse y el spinner se queda colgado pese a haber vídeo. Por
    // eso reaccionamos también a "loadeddata"/"canplay" (más tempranos) y a que
    // el <video> ya tenga datos (readyState >= HAVE_CURRENT_DATA).
    const onPlaying = () => {
      retryDelay = 1000; // el stream se recuperó: reseteamos el backoff
      failStreak = 0; // y la racha de fallos
      setStatus("playing");
      onStatus?.("playing");
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadeddata", onPlaying);
    video.addEventListener("canplay", onPlaying);
    // Empuja el autoplay: si el navegador no arranca solo, el spinner nunca se
    // quitaría. Lo intentamos al tener datos (ignorando el rechazo de autoplay).
    const tryPlay = () => video.play?.().catch(() => {});
    video.addEventListener("loadedmetadata", tryPlay);

    // Programa un reintento del stream tras un fallo fatal (con backoff).
    // Mientras no superemos el umbral seguimos en "loading" (spinner), porque
    // una V380 casi siempre vuelve en unos segundos. Pasado el umbral damos la
    // cámara por caída ("error") pero SEGUIMOS reintentando en segundo plano,
    // para que vuelva sola si la cámara se reconecta.
    const scheduleRetry = (reason) => {
      if (destroyed) return;
      failStreak += 1;
      const down = failStreak >= FAIL_THRESHOLD;
      console.warn(`HLS ${name}: ${reason} — reintentando en ${retryDelay}ms`);
      onReconnect?.(reason); // contabiliza la pérdida de señal (calidad de enlace)
      setStatus(down ? "error" : "loading");
      onStatus?.(down ? "error" : "loading");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (destroyed) return;
        retryDelay = Math.min(MAX_DELAY, retryDelay * 2);
        start();
      }, retryDelay);
    };

    const start = () => {
      if (destroyed) return;

      // Si ya habíamos dado la cámara por caída, este reintento es una
      // reconexión: mostramos "Conectando…" en vez de seguir en "error".
      if (failStreak >= FAIL_THRESHOLD) {
        setStatus("reconnecting");
        onStatus?.("reconnecting");
      }

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
      video.removeEventListener("loadeddata", onPlaying);
      video.removeEventListener("canplay", onPlaying);
      video.removeEventListener("loadedmetadata", tryPlay);
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
