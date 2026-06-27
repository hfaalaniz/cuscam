import { useEffect, useRef, useState, useCallback } from "react";
import Timeline from "./Timeline.jsx";
import FloatingWindow from "./FloatingWindow.jsx";

/**
 * Visor de grabaciones de una cámara: ventana FLOTANTE y arrastrable (no es un
 * overlay que bloquee el resto de la app). Reproductor tipo DVR con timeline
 * continuo y cursor de fecha/hora real; al hacer clic en la barra salta a ese
 * instante, encadenando los segmentos automáticamente.
 *
 * Lee GET /api/cameras/:id/timeline y sirve cada .mp4 con soporte de Range.
 */
export default function RecordingsModal({ camera, onClose }) {
  const [segments, setSegments] = useState([]);
  const [range, setRange] = useState({ start: null, end: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(null); // segmento en reproducción
  const [currentMs, setCurrentMs] = useState(null); // hora de pared actual
  const [selection, setSelection] = useState(null); // { from, to } a exportar
  const [exporting, setExporting] = useState(false);
  const videoRef = useRef(null);

  // Carga la línea de tiempo.
  useEffect(() => {
    let aborted = false;
    fetch(`/api/cameras/${camera.id}/timeline`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar");
        return json;
      })
      .then((json) => {
        if (aborted) return;
        setSegments(json.segments || []);
        setRange({ start: json.rangeStart, end: json.rangeEnd });
      })
      .catch((err) => !aborted && setError(err.message))
      .finally(() => !aborted && setLoading(false));
    return () => {
      aborted = true;
    };
  }, [camera.id]);

  const srcOf = (idx) =>
    `/api/cameras/${camera.id}/recordings/${encodeURI(segments[idx].file)}`;
  const downloadOf = (idx) => srcOf(idx) + "?download=1";

  // Reproduce un instante (hora de pared): localiza el segmento y el offset.
  const seekTo = useCallback(
    (ms) => {
      const idx = segments.findIndex((s) => ms >= s.start && ms < s.end);
      if (idx === -1) {
        // Hueco sin grabación: salta al siguiente segmento que empieza después.
        const next = segments.findIndex((s) => s.start >= ms);
        if (next === -1) return;
        setActiveIdx(next);
        pendingSeek.current = 0;
        return;
      }
      const offsetSec = (ms - segments[idx].start) / 1000;
      if (idx === activeIdx && videoRef.current) {
        videoRef.current.currentTime = offsetSec;
      } else {
        setActiveIdx(idx);
        pendingSeek.current = offsetSec; // se aplica al cargar metadata
      }
    },
    [segments, activeIdx]
  );

  // Offset a aplicar cuando el nuevo segmento esté listo.
  const pendingSeek = useRef(null);

  function handleLoadedMetadata() {
    if (pendingSeek.current != null && videoRef.current) {
      videoRef.current.currentTime = pendingSeek.current;
      pendingSeek.current = null;
    }
  }

  function handleTimeUpdate() {
    if (activeIdx == null || !videoRef.current) return;
    setCurrentMs(segments[activeIdx].start + videoRef.current.currentTime * 1000);
  }

  // Al terminar un segmento, encadena el siguiente (reproducción continua).
  function handleEnded() {
    if (activeIdx != null && activeIdx + 1 < segments.length) {
      pendingSeek.current = 0;
      setActiveIdx(activeIdx + 1);
    }
  }

  // Exporta el rango seleccionado como un único MP4 (descarga del backend).
  async function handleExport() {
    if (!selection) return;
    setExporting(true);
    try {
      const url =
        `/api/cameras/${camera.id}/export` +
        `?from=${Math.round(selection.from)}&to=${Math.round(selection.to)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "No se pudo exportar");
      }
      // Descarga el blob resultante con el nombre del header.
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = m ? m[1] : "clip.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      alert("Error al exportar: " + err.message);
    } finally {
      setExporting(false);
    }
  }

  const fmtClock = (ms) =>
    new Date(ms).toLocaleString([], {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const selDurationSec = selection
    ? Math.round((selection.to - selection.from) / 1000)
    : 0;

  const hasData = segments.length > 0 && range.start != null;

  return (
    <FloatingWindow title={`Grabaciones — ${camera.name}`} onClose={onClose} wide>
      {loading && <p className="banner-info">Cargando línea de tiempo…</p>}
        {error && <p className="modal-error">{error}</p>}

        {!loading && !error && !hasData && (
          <p className="modal-hint">
            No hay grabaciones todavía para esta cámara. Los segmentos aparecerán
            aquí en cuanto se cierre el primero.
          </p>
        )}

        {hasData && (
          <>
            <div className="rec-player">
              {activeIdx != null ? (
                <video
                  key={activeIdx}
                  ref={videoRef}
                  className="rec-video"
                  src={srcOf(activeIdx)}
                  controls
                  autoPlay
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  onEnded={handleEnded}
                />
              ) : (
                <div className="rec-placeholder">
                  Haz clic en la línea de tiempo para empezar a reproducir.
                </div>
              )}
            </div>

            <Timeline
              cameraId={camera.id}
              segments={segments}
              rangeStart={range.start}
              rangeEnd={range.end}
              currentMs={currentMs}
              selection={selection}
              onSeek={seekTo}
              onSelect={setSelection}
            />

            <p className="modal-hint tl-help">
              Clic para reproducir · arrastra sobre la barra para seleccionar un
              rango a exportar.
            </p>

            <div className="rec-player-actions">
              {selection ? (
                <>
                  <span className="rec-sel-label">
                    Selección: {fmtClock(selection.from)} → {fmtClock(selection.to)}{" "}
                    ({selDurationSec}s)
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleExport}
                    disabled={exporting}
                  >
                    {exporting ? "Exportando…" : "⬇ Exportar clip MP4"}
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSelection(null)}
                    disabled={exporting}
                  >
                    Limpiar
                  </button>
                </>
              ) : (
                activeIdx != null && (
                  <a className="btn btn-ghost btn-sm" href={downloadOf(activeIdx)}>
                    ⬇ Descargar segmento actual
                  </a>
                )
              )}
            </div>
          </>
        )}
    </FloatingWindow>
  );
}
