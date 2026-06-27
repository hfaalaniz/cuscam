import { useEffect, useState } from "react";
import HlsPlayer from "./HlsPlayer.jsx";
import AddCameraModal from "./AddCameraModal.jsx";
import CredentialsModal from "./CredentialsModal.jsx";
import NetworkModal from "./NetworkModal.jsx";
import WifiModal from "./WifiModal.jsx";
import EditCameraModal from "./EditCameraModal.jsx";
import CapabilitiesModal from "./CapabilitiesModal.jsx";
import ExpandedCameraModal from "./ExpandedCameraModal.jsx";

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
  const [mode, setMode] = useState(
    () => localStorage.getItem("cuscam-mode") || "hls"
  ); // "webrtc" | "hls"

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
            cameraId={cam.id}
            url={cam.url}
            webrtcUrl={cam.webrtcUrl}
            name={cam.name}
            mode={mode}
            quality={cam.quality || "low"}
            switching={cam.switching}
            onToggleQuality={() => handleToggleQuality(cam)}
            onEdit={() => setEditFor(cam)}
            onCapabilities={() => setCapsFor(cam)}
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
    </div>
  );
}
