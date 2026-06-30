import { useEffect, useRef, useState } from "react";

/**
 * Barra de línea de tiempo tipo DVR. Pinta los tramos grabados sobre el rango
 * total [rangeStart, rangeEnd] y un cursor en `currentMs` (hora de pared que se
 * está reproduciendo). Clic = onSeek(ms). Arrastrar = selección de rango para
 * exportar, emitida por onSelect({from, to}) (o onSelect(null) al limpiar).
 * Al pasar el ratón muestra un fotograma de previsualización de ese instante.
 *
 * Props:
 *  - cameraId: id de la cámara (para pedir los fotogramas de preview)
 *  - segments: [{ start, end }]  (ms epoch)
 *  - rangeStart, rangeEnd: ms epoch (extremos de la barra)
 *  - currentMs: posición actual del cursor (ms epoch) o null
 *  - selection: { from, to } | null  (rango marcado, controlado por el padre)
 *  - onSeek(ms): el usuario eligió un instante (clic simple)
 *  - onSelect({from,to}|null): el usuario marcó/limpió un rango
 */
export default function Timeline({
  cameraId,
  segments,
  rangeStart,
  rangeEnd,
  currentMs,
  selection,
  onSeek,
  onSelect,
}) {
  const barRef = useRef(null);
  const [hover, setHover] = useState(null); // { x, ms }
  const [previewUrl, setPreviewUrl] = useState(null); // URL del frame de hover
  const drag = useRef(null); // { startMs, moved }

  const span = Math.max(1, rangeEnd - rangeStart);
  const pct = (ms) => ((ms - rangeStart) / span) * 100;

  const fmt = (ms) =>
    new Date(ms).toLocaleString([], {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const fmtShort = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const inSegment = (ms) => segments.some((s) => ms >= s.start && ms < s.end);

  // Carga el fotograma de previsualización con debounce mientras se mueve el
  // ratón (evita una petición por cada píxel). Solo dentro de tramos grabados;
  // si el backend no tiene frame para ese instante, el <img> se oculta solo
  // (onError) — así no dependemos de que `inSegment` sea exacto al píxel.
  const hoverBucket = hover ? Math.floor(hover.ms / 2000) * 2000 : null;
  const hoverInSeg = hover ? inSegment(hover.ms) : false;
  useEffect(() => {
    if (!hover || !cameraId || !hoverInSeg) {
      setPreviewUrl(null);
      return;
    }
    const t = setTimeout(() => {
      setPreviewUrl(`/api/cameras/${cameraId}/frame?at=${hoverBucket}`);
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverBucket, hoverInSeg, cameraId]);

  function msFromClientX(clientX) {
    const rect = barRef.current.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return rangeStart + (x / rect.width) * span;
  }

  function handleDown(e) {
    drag.current = { startMs: msFromClientX(e.clientX), moved: false };
  }
  function handleMove(e) {
    const rect = barRef.current.getBoundingClientRect();
    setHover({ x: e.clientX - rect.left, ms: msFromClientX(e.clientX) });
    if (drag.current) {
      const cur = msFromClientX(e.clientX);
      if (Math.abs(cur - drag.current.startMs) > span * 0.005) {
        drag.current.moved = true;
        const from = Math.min(drag.current.startMs, cur);
        const to = Math.max(drag.current.startMs, cur);
        onSelect?.({ from, to });
      }
    }
  }
  function handleUp(e) {
    if (drag.current) {
      if (!drag.current.moved) {
        // Clic simple: reproducir ese instante y limpiar selección.
        onSeek?.(msFromClientX(e.clientX));
        onSelect?.(null);
      }
      drag.current = null;
    }
  }
  function handleLeave() {
    setHover(null);
    // No cancelamos el arrastre aquí; el mouseup global lo cierra.
  }

  // Marcas de tiempo regulares (5 divisiones).
  const ticks = [];
  for (let i = 0; i <= 5; i++) ticks.push(rangeStart + (span * i) / 5);

  return (
    <div className="tl">
      <div
        className="tl-bar"
        ref={barRef}
        onMouseDown={handleDown}
        onMouseMove={handleMove}
        onMouseUp={handleUp}
        onMouseLeave={handleLeave}
      >
        {/* Tramos grabados */}
        {segments.map((s, i) => (
          <div
            key={i}
            className="tl-seg"
            style={{ left: pct(s.start) + "%", width: pct(s.end) - pct(s.start) + "%" }}
            title={`${fmt(s.start)} → ${fmt(s.end)}`}
          />
        ))}

        {/* Selección de rango para exportar */}
        {selection && (
          <div
            className="tl-selection"
            style={{
              left: pct(selection.from) + "%",
              width: pct(selection.to) - pct(selection.from) + "%",
            }}
          />
        )}

        {/* Cursor de reproducción */}
        {currentMs != null && currentMs >= rangeStart && currentMs <= rangeEnd && (
          <div className="tl-cursor" style={{ left: pct(currentMs) + "%" }} />
        )}

        {/* Línea vertical de hover (dentro de la barra) */}
        {hover && (
          <div className="tl-hover-line" style={{ left: hover.x + "px" }} />
        )}
      </div>

      {/* Overlay de previsualización FUERA de la barra (sin overflow:hidden),
          para que el fotograma y la etiqueta no queden recortados. */}
      {hover && (
        <div className="tl-hover-overlay">
          {previewUrl && (
            <div className="tl-hover-thumb" style={{ left: hover.x + "px" }}>
              <img
                src={previewUrl}
                alt=""
                draggable={false}
                onError={() => setPreviewUrl(null)}
              />
            </div>
          )}
          <div className="tl-hover-label" style={{ left: hover.x + "px" }}>
            {fmt(hover.ms)}
          </div>
        </div>
      )}

      {/* Etiquetas de tiempo */}
      <div className="tl-ticks">
        {ticks.map((t, i) => (
          <span key={i} className="tl-tick">
            {fmtShort(t)}
          </span>
        ))}
      </div>

      {currentMs != null && <div className="tl-now">▶ {fmt(currentMs)}</div>}
    </div>
  );
}
