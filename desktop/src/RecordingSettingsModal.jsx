import { useEffect, useState } from "react";

/**
 * Panel de configuración global de grabación. Lee/guarda en
 * GET|PUT /api/recording/config. Guardar regenera la config de MediaMTX y lo
 * reinicia (corte de ~2s en todas las cámaras), por eso se avisa al usuario.
 */
export default function RecordingSettingsModal({ onClose, onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let aborted = false;
    fetch("/api/recording/config")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Error al consultar");
        return json;
      })
      .then((json) => {
        if (aborted) return;
        setCfg(json.recording);
        setStats(json.stats);
      })
      .catch((err) => !aborted && setError(err.message))
      .finally(() => !aborted && setLoading(false));
    return () => {
      aborted = true;
    };
  }, []);

  const fmtSize = (b) => {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + " GB";
    if (b >= 1e6) return (b / 1e6).toFixed(1) + " MB";
    return (b / 1e3).toFixed(0) + " KB";
  };

  async function handleSave() {
    if (
      !window.confirm(
        "Guardar reiniciará MediaMTX para aplicar los cambios. Habrá un corte " +
          "de vídeo de ~2 segundos en todas las cámaras. ¿Continuar?"
      )
    )
      return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/recording/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: cfg.enabled,
          retentionHours: cfg.retentionHours,
          segmentDuration: cfg.segmentDuration,
          format: cfg.format,
          dir: cfg.dir,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo guardar");
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const retentionDays = cfg ? Math.round((cfg.retentionHours / 24) * 10) / 10 : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Configuración de grabación</h2>

        {loading && <p className="banner-info">Cargando…</p>}
        {error && <p className="modal-error">{error}</p>}

        {cfg && (
          <>
            <label className="rec-field rec-toggle">
              <input
                type="checkbox"
                checked={cfg.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <span>Grabación continua 24/7 activada</span>
            </label>

            <label className="rec-field">
              <span>Retención (días)</span>
              <input
                type="number"
                min="1"
                value={retentionDays}
                onChange={(e) =>
                  set({ retentionHours: Math.max(1, Number(e.target.value) * 24) })
                }
              />
              <small className="modal-hint">
                Las grabaciones más antiguas se borran automáticamente.
              </small>
            </label>

            <label className="rec-field">
              <span>Duración de cada segmento</span>
              <select
                value={cfg.segmentDuration}
                onChange={(e) => set({ segmentDuration: e.target.value })}
              >
                <option value="15m">15 minutos</option>
                <option value="30m">30 minutos</option>
                <option value="1h">1 hora</option>
                <option value="2h">2 horas</option>
              </select>
            </label>

            <label className="rec-field">
              <span>Formato</span>
              <select
                value={cfg.format}
                onChange={(e) => set({ format: e.target.value })}
              >
                <option value="fmp4">fMP4 (robusto ante cortes)</option>
                <option value="mp4">MP4</option>
              </select>
            </label>

            {stats && (
              <p className="modal-hint">
                Uso actual en disco: <strong>{fmtSize(stats.usedBytes)}</strong>{" "}
                en {stats.files} archivo(s) · carpeta <code>{cfg.dir}</code>
              </p>
            )}

            <p className="modal-warn">
              ⚠ Guardar reinicia MediaMTX (corte de ~2 s en todas las cámaras).
            </p>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={loading || saving || !cfg}
          >
            {saving ? "Guardando y reiniciando…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}
