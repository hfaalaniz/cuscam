import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

/**
 * Reproductor HLS de baja latencia. Usa hls.js donde no hay HLS nativo
 * (Chrome/Edge/Firefox) y cae al soporte nativo del <video> en Safari.
 */
export default function HlsVideo({ url, name, onStatus }) {
  const videoRef = useRef(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let hls;
    setStatus("loading");
    onStatus?.("loading");

    const onPlaying = () => {
      setStatus("playing");
      onStatus?.("playing");
    };
    video.addEventListener("playing", onPlaying);

    const fail = (detail) => {
      console.error(`Fallo HLS en ${name}:`, detail);
      setStatus("error");
      onStatus?.("error");
    };

    if (Hls.isSupported()) {
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
        if (data.fatal) fail(`${data.type} ${data.details}`);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.addEventListener("error", () => fail("native error"));
    } else {
      fail("HLS no soportado");
    }

    return () => {
      video.removeEventListener("playing", onPlaying);
      if (hls) hls.destroy();
    };
  }, [url, name, onStatus]);

  return (
    <video
      ref={videoRef}
      className="video"
      muted
      autoPlay
      playsInline
      controls={false}
      data-status={status}
    />
  );
}
