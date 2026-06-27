import { useState } from "react";

/**
 * Campo de contraseña con botón de "ojo" para mostrar/ocultar el valor.
 * Acepta las mismas props que un <input> controlado (value, onChange, ...).
 */
export default function PasswordInput({ value, onChange, placeholder, autoFocus }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-wrap">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="password-input"
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((v) => !v)}
        title={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
        aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
      >
        {visible ? "🙈" : "👁"}
      </button>
    </div>
  );
}
