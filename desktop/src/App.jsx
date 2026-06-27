import { useEffect, useRef, useState } from "react";
import HlsPlayer from "./HlsPlayer.jsx";
import AddCameraModal from "./AddCameraModal.jsx";
import CredentialsModal from "./CredentialsModal.jsx";
import NetworkModal from "./NetworkModal.jsx";
import WifiModal from "./WifiModal.jsx";
import EditCameraModal from "./EditCameraModal.jsx";
import CapabilitiesModal from "./CapabilitiesModal.jsx";
import ExpandedCameraModal from "./ExpandedCameraModal.jsx";
import RecordingsModal from "./RecordingsModal.jsx";
import RecordingSettingsModal from "./RecordingSettingsModal.jsx";
import SignalHistoryModal from "./SignalHistoryModal.jsx";

export default function App() {
  const [cameras, setCameras] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showNetwork, setShowNetwork] = useState(false);
  const [credsFor, setCredsFor] = useState(null); // cámara seleccionada para credenciales
  const [wifiFor, setWifiFor] = useState(null); // cámara seleccionada para Wi-Fi
  const [editFor, setEditFor] = useState(null); // cámara seleccionada para editar todo
  const [capsFor, setCapsFor] = useState(null); // cámara seleccionada para ver capacidades
  const [expandedId, setExpandedId] = useState(null); // id de cámara ampliada (doble click)
  const [recsFor, setRecsFor] = useState(null); // cámara para ver grabaciones
  const [signalFor, setSignalFor] = useState(null); // cámara para historial de señal
  const [showRecSettings, setShowRecSettings] = useState(false); // panel config grabación
  const [activeId, setActiveId] = useState(null); // ventana activa para control por teclado
  // El audio sigue a la ventana activa (exclusivo). `audioMuted` permite
  // silenciar manualmente la cámara activa sin perder el foco.
  const [audioMuted, setAudioMuted] = useState(false);
  const [mode, setMode] = useState(
    () => localStorage.getItem("cuscam-mode") || "hls"
  ); // "webrtc" | "hls"

  // Refs a cada tarjeta para invocar PTZ/zoom de la ventana activa.
  const playerRefs = useRef(new Map());

  function changeMode(next) {
    setMode(next);
    localStorage.setItem("cuscam-mode", next);
  }

  function loadCameras() {
    setLoading(true);
    fetch("/api/cameras")
      .then((res) => {
        if (!res.ok) throw new Error("Respuesta no válida del backend");
        return res.json();
      })
      .then((data) => {
        setCameras(data.cameras || []);
        setError(null);
      })
      .catch((err) => {
        console.error("No se pudo cargar la lista de cámaras:", err);
        setError("No se pudo conectar con el backend (¿está corriendo en :3000?).");
      })
      .finally(() => setLoading(false));
  }

  useEffect(loadCameras, []);

  // Si no hay ventana activa, activa la primera cámara cuando se carguen.
  useEffect(() => {
    if (activeId == null && cameras.length > 0) setActiveId(cameras[0].id);
    if (activeId != null && !cameras.some((c) => c.id === activeId)) {
      setActiveId(cameras[0]?.id ?? null);
    }
  }, [cameras, activeId]);

  // Al cambiar de ventana activa, el audio se reactiva en la nueva (sigue al foco).
  useEffect(() => {
    setAudioMuted(false);
  }, [activeId]);

  // Control por teclado de la ventana activa:
  //  · Flechas  -> PAN/TILT (mover al pulsar, detener al soltar)
  //  · TAB      -> pasa la ventana activa a la siguiente (Shift+TAB: anterior)
  //  · +/-      -> zoom digital
  useEffect(() => {
    // Mientras la ventana ampliada está abierta, ella gestiona el teclado.
    if (expandedId != null) return;

    const ARROWS = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    let moving = null; // dirección que se está moviendo por teclado
    let keepAlive = null; // intervalo que reenvía el comando mientras se pulsa

    // No interceptar el teclado mientras se escribe en un campo/modal.
    const typing = (t) =>
      t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    function activePlayer() {
      return activeId != null ? playerRefs.current.get(activeId) : null;
    }

    // Movimiento continuo: envía el comando y lo REENVÍA cada 400ms (keep-alive)
    // para que la cámara no se autodetenga por el timeout de seguridad ONVIF.
    function startMoving(dir) {
      moving = dir;
      activePlayer()?.moveStart(dir);
      clearInterval(keepAlive);
      keepAlive = setInterval(() => activePlayer()?.moveStart(dir), 400);
    }

    function stopMoving() {
      if (!moving) return;
      moving = null;
      clearInterval(keepAlive);
      keepAlive = null;
      activePlayer()?.moveStop();
    }

    function cycle(delta) {
      if (cameras.length === 0) return;
      const idx = cameras.findIndex((c) => c.id === activeId);
      const next = (idx + delta + cameras.length) % cameras.length;
      setActiveId(cameras[next].id);
    }

    function onKeyDown(e) {
      if (typing(e.target)) return;

      if (e.key === "Tab") {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
        return;
      }

      const dir = ARROWS[e.key];
      if (dir) {
        e.preventDefault();
        if (e.repeat) return; // el navegador repite keydown; el keep-alive ya mueve
        if (moving !== dir) startMoving(dir);
        return;
      }

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        activePlayer()?.zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        activePlayer()?.zoomOut();
      }
    }

    function onKeyUp(e) {
      // Detiene solo si se suelta la tecla de la dirección que se está moviendo.
      if (ARROWS[e.key] && ARROWS[e.key] === moving) stopMoving();
    }

    // Si se pierde el foco de la ventana con una flecha pulsada, detenemos.
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
      clearInterval(keepAlive); // limpia el keep-alive al desmontar/recambiar
    };
  }, [cameras, activeId, expandedId]);

  async function handleDelete(cam) {
    if (!window.confirm(`¿Eliminar la cámara "${cam.name}"?`)) return;
    try {
      const res = await fetch(`/api/cameras/${cam.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setCameras((list) => list.filter((c) => c.id !== cam.id));
    } catch {
      alert("No se pudo eliminar la cámara.");
    }
  }

  function handleAdded(camera) {
    setCameras((list) => [...list, camera]);
    setShowAdd(false);
  }

  function handleCredsSaved(camera) {
    setCameras((list) => list.map((c) => (c.id === camera.id ? camera : c)));
    setCredsFor(null);
  }

  function handleNetworkSaved() {
    setShowNetwork(false);
    loadCameras(); // las URLs cambian, recargamos
  }

  function handleEditSaved(camera) {
    setCameras((list) => list.map((c) => (c.id === camera.id ? camera : c)));
    setEditFor(null);
  }

  async function handleToggleQuality(cam) {
    const next = cam.quality === "high" ? "low" : "high";
    // Marca la cámara como "cambiando" SIN remontar todavía el reproductor.
    setCameras((list) =>
      list.map((c) => (c.id === cam.id ? { ...c, switching: true } : c))
    );
    try {
      const res = await fetch(`/api/cameras/${cam.id}/quality`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quality: next }),
      });
      if (!res.ok) throw new Error();
      // El backend ya esperó a que el nuevo stream esté listo:
      // ahora sí aplicamos la calidad (esto remonta el reproductor).
      setCameras((list) =>
        list.map((c) =>
          c.id === cam.id ? { ...c, quality: next, switching: false } : c
        )
      );
    } catch {
      setCameras((list) =>
        list.map((c) => (c.id === cam.id ? { ...c, switching: false } : c))
      );
      alert("No se pudo cambiar la calidad.");
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="main-title">Centro de Monitoreo Residencial</h1>
        <div className="header-actions">
          <div className="mode-switch" title="Modo de transmisión">
            <button
              className={"mode-opt" + (mode === "webrtc" ? " mode-opt-on" : "")}
              onClick={() => changeMode("webrtc")}
            >
              WebRTC · tiempo real
            </button>
            <button
              className={"mode-opt" + (mode === "hls" ? " mode-opt-on" : "")}
              onClick={() => changeMode("hls")}
            >
              HLS · estable
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => setShowRecSettings(true)}>
            ⏺ Grabación
          </button>
          <button className="btn btn-ghost" onClick={() => setShowNetwork(true)}>
            ⚙ Red
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Agregar cámara
          </button>
        </div>
      </header>

      {error && <p className="banner-error">{error}</p>}

      {loading && <p className="banner-info">Cargando cámaras…</p>}

      {!loading && !error && cameras.length === 0 && (
        <p className="banner-info">
          No hay cámaras configuradas. Usa “Agregar cámara” para empezar.
        </p>
      )}

      <div className="grid">
        {cameras.map((cam) => (
          <HlsPlayer
            key={cam.id + "-" + mode + "-" + (cam.quality || "low")}
            ref={(el) => {
              if (el) playerRefs.current.set(cam.id, el);
              else playerRefs.current.delete(cam.id);
            }}
            cameraId={cam.id}
            url={cam.url}
            webrtcUrl={cam.webrtcUrl}
            name={cam.name}
            mode={mode}
            quality={cam.quality || "low"}
            switching={cam.switching}
            active={cam.id === activeId}
            recording={cam.recording}
            audioOn={cam.id === activeId && !audioMuted}
            onToggleAudio={() => {
              if (cam.id === activeId) {
                // Es la activa: alterna su silencio.
                setAudioMuted((m) => !m);
              } else {
                // No es la activa: activarla (su audio se enciende solo).
                setActiveId(cam.id);
              }
            }}
            onActivate={() => setActiveId(cam.id)}
            onToggleQuality={() => handleToggleQuality(cam)}
            onEdit={() => setEditFor(cam)}
            onCapabilities={() => setCapsFor(cam)}
            onRecordings={() => setRecsFor(cam)}
            onSignalHistory={() => setSignalFor(cam)}
            onDelete={() => handleDelete(cam)}
            onCredentials={() => setCredsFor(cam)}
            onWifi={() => setWifiFor(cam)}
            onExpand={() => setExpandedId(cam.id)}
          />
        ))}
      </div>

      {showAdd && (
        <AddCameraModal onClose={() => setShowAdd(false)} onAdded={handleAdded} />
      )}

      {showNetwork && (
        <NetworkModal
          onClose={() => setShowNetwork(false)}
          onSaved={handleNetworkSaved}
        />
      )}

      {credsFor && (
        <CredentialsModal
          camera={credsFor}
          onClose={() => setCredsFor(null)}
          onSaved={handleCredsSaved}
        />
      )}

      {wifiFor && (
        <WifiModal
          camera={wifiFor}
          onClose={() => setWifiFor(null)}
          onSaved={() => setWifiFor(null)}
        />
      )}

      {editFor && (
        <EditCameraModal
          camera={editFor}
          onClose={() => setEditFor(null)}
          onSaved={handleEditSaved}
        />
      )}

      {capsFor && (
        <CapabilitiesModal
          camera={capsFor}
          onClose={() => setCapsFor(null)}
        />
      )}

      {expandedId && cameras.find((c) => c.id === expandedId) && (
        <ExpandedCameraModal
          camera={cameras.find((c) => c.id === expandedId)}
          mode={mode}
          onClose={() => setExpandedId(null)}
        />
      )}

      {recsFor && (
        <RecordingsModal camera={recsFor} onClose={() => setRecsFor(null)} />
      )}

      {signalFor && (
        <SignalHistoryModal
          camera={signalFor}
          onClose={() => setSignalFor(null)}
        />
      )}

      {showRecSettings && (
        <RecordingSettingsModal
          onClose={() => setShowRecSettings(false)}
          onSaved={() => {
            setShowRecSettings(false);
            loadCameras(); // refresca el estado "recording" de cada cámara
          }}
        />
      )}
    </div>
  );
}
