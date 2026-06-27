import { useEffect, useRef, useState } from "react";

/**
 * Ventana flotante arrastrable reutilizable por todos los modales.
 * - Barra de título arrastrable (mover la ventana por la pantalla).
 * - Botón de cierre ✕ y cierre con Escape.
 * - No bloquea el resto de la app (no hay backdrop oscuro).
 *
 * Props:
 *  - title: texto de la barra de título
 *  - onClose: callback al cerrar
 *  - wide: ventana más ancha (para tablas/timeline)
 *  - initialOffset: desplaza la posición inicial (para apilar varias ventanas)
 *  - children: contenido del cuerpo
 */
export default function FloatingWindow({
  title,
  onClose,
  wide = false,
  initialOffset = 0,
  children,
}) {
  const width = wide ? 600 : 460;
  const [pos, setPos] = useState(() => ({
    x: Math.max(20, window.innerWidth / 2 - width / 2 + initialOffset),
    y: Math.max(20, window.innerHeight / 2 - 240 + initialOffset),
  }));
  const dragRef = useRef(null); // { offsetX, offsetY } durante el arrastre

  // Arrastre con listeners globales (el movimiento sigue aunque el ratón salga).
  useEffect(() => {
    function onMove(e) {
      if (!dragRef.current) return;
      const x = e.clientX - dragRef.current.offsetX;
      const y = e.clientY - dragRef.current.offsetY;
      setPos({
        x: Math.min(Math.max(-(width - 120), x), window.innerWidth - 80),
        y: Math.min(Math.max(0, y), window.innerHeight - 40),
      });
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [width]);

  // Cerrar con Escape.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function startDrag(e) {
    if (e.button !== 0) return;
    dragRef.current = { offsetX: e.clientX - pos.x, offsetY: e.clientY - pos.y };
  }

  return (
    <div
      className={"float-window" + (wide ? " float-wide" : "")}
      style={{ left: pos.x + "px", top: pos.y + "px" }}
    >
      <div className="float-titlebar" onMouseDown={startDrag}>
        <span className="float-title">{title}</span>
        <button
          type="button"
          className="float-close"
          title="Cerrar"
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation()}
        >
          ✕
        </button>
      </div>
      <div className="float-body">{children}</div>
    </div>
  );
}
