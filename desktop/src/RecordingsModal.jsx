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
  const [days, setDays] = useState([]); // [{ day, segments, start, end }]
  const [selectedDay, setSelectedDay] = useState(""); // "YYYY-MM-DD" o "" = todo
  const videoRef = useRef(null);

  // Carga la lista de días con grabación (para el selector). Por defecto
  // selecciona el más reciente para no cargar de golpe todo el historial.
  useEffect(() => {
    let aborted = false;
    fetch(`/api/cameras/${camera.id}/recording-days`)
      .then((res) => res.json())
      .then((json) => {
        if (aborted) return;
        const ds = json.days || [];
        setDays(ds);
        setSelectedDay(ds.length ? ds[0].day : "");
      })
      .catch(() => {});
    return () => {
      aborted = true;
    };
  }, [camera.id]);

  // Convierte "YYYY-MM-DD" (hora local) al rango [from, to) en ms epoch del día.
  function dayRange(day) {
    if (!day) return null;
    const [y, m, d] = day.split("-").map(Number);
    const from = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const to = from + 24 * 60 * 60 * 1000;
    return { from, to };
  }

  // Carga la línea de tiempo (filtrada por el día seleccionado, si hay uno).
  useEffect(() => {
    let aborted = false;
    setLoading(true);
    // Al cambiar de día reseteamos la reproducción.
    setActiveIdx(null);
    setCurrentMs(null);
    setSelection(null);

    let url = `/api/cameras/${camera.id}/timeline`;
    const r = dayRange(selectedDay);
    if (r) url += `?from=${r.from}&to=${r.to}`;

    fetch(url)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar");
        return json;
      })
      .then((json) => {
        if (aborted) return;
        setSegments(json.segments || []);
        // Si filtramos por día, acotamos la barra a ese día completo para que
        // las horas del eje sean coherentes (00:00 → 24:00); si no, al rango real.
        if (r) setRange({ start: r.from, end: r.to });
        else setRange({ start: json.rangeStart, end: json.rangeEnd });
      })
      .catch((err) => !aborted && setError(err.message))
      .finally(() => !aborted && setLoading(false));
    return () => {
      aborted = true;
    };
  }, [camera.id, selectedDay]);

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
        setCurrentMs(segments[next].start);
        pendingSeek.current = 0;
        return;
      }
      const offsetSec = (ms - segments[idx].start) / 1000;
      // Posiciona el cursor en el instante elegido de inmediato, sin esperar al
      // primer "timeupdate" (si no, el cursor se quedaba en la posición previa
      // —p. ej. el final del segmento anterior— hasta que el vídeo emitía).
      setCurrentMs(ms);
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

  // Etiqueta legible de un día ("YYYY-MM-DD" -> "lun 30 jun 2026").
  const fmtDay = (day) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  return (
    <FloatingWindow title={`Grabaciones — ${camera.name}`} onClose={onClose} wide>
        {/* Selector de día de grabación */}
        {days.length > 0 && (
          <div className="rec-day-bar">
            <label className="rec-day-label">📅 Día:</label>
            <select
              className="rec-day-select"
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value)}
            >
              {days.map((d) => (
                <option key={d.day} value={d.day}>
                  {fmtDay(d.day)} · {d.segments} segmento{d.segments !== 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {loading && <p className="banner-info">Cargando línea de tiempo…</p>}
        {error && <p className="modal-error">{error}</p>}

        {!loading && !error && !hasData && (
          <p className="modal-hint">
            {days.length === 0
              ? "No hay grabaciones todavía para esta cámara. Los segmentos aparecerán aquí en cuanto se cierre el primero."
              : "No hay grabaciones en el día seleccionado."}
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
