import { useEffect, useRef, useState } from "react";

/**
 * Reproductor WebRTC (WHEP) para MediaMTX — latencia casi en tiempo real (<1s).
 * Implementa el handshake WHEP: crea una oferta SDP, la envía por POST al
 * endpoint /whep de MediaMTX y aplica la respuesta.
 */
export default function WebrtcPlayer({ url, name, onStatus }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const [status, setStatus] = useState("loading"); // loading | playing | error

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let aborted = false;
    setStatus("loading");
    onStatus?.("loading");

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    // Solo recibimos (la cámara emite hacia nosotros).
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (event) => {
      if (video.srcObject !== event.streams[0]) {
        video.srcObject = event.streams[0];
      }
    };

    let started = false;
    const onPlaying = () => {
      started = true;
      clearTimeout(connectTimer);
      setStatus("playing");
      onStatus?.("playing");
    };
    video.addEventListener("playing", onPlaying);

    // Si WebRTC no logra reproducir en 6s (típico por internet/UDP bloqueado),
    // lo damos por fallido para que el contenedor caiga a HLS.
    const connectTimer = setTimeout(() => {
      if (!started && !aborted) {
        console.warn(`WebRTC sin imagen tras 6s en ${name}, forzando fallback`);
        setStatus("error");
        onStatus?.("error");
      }
    }, 6000);

    async function negotiate() {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Espera a reunir candidatos ICE (negociación no-trickle, más simple).
        await waitIceGathering(pc);

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: pc.localDescription.sdp,
        });
        if (!res.ok) throw new Error(`WHEP HTTP ${res.status}`);

        const answerSdp = await res.text();
        if (aborted) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } catch (err) {
        if (aborted) return;
        console.error(`WebRTC falló en ${name}:`, err.message);
        setStatus("error");
        onStatus?.("error");
      }
    }

    negotiate();

    return () => {
      aborted = true;
      clearTimeout(connectTimer);
      video.removeEventListener("playing", onPlaying);
      pc.close();
      video.srcObject = null;
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

/** Espera a que termine la recolección de candidatos ICE (o 1.5s máx). */
function waitIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timeout = setTimeout(resolve, 1500);
    pc.addEventListener("icegatheringstatechange", function check() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    });
  });
}
