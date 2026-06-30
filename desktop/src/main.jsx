import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import LoginScreen from "./LoginScreen.jsx";
import "./styles.css";

/**
 * Raíz de la app: comprueba el estado de autenticación con el backend.
 *  · Si la auth está desactivada o ya hay sesión -> muestra la app.
 *  · Si requiere login -> muestra la pantalla de inicio de sesión.
 */
function Root() {
  const [state, setState] = useState({ loading: true, loggedIn: false });

  function checkAuth() {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => setState({ loading: false, loggedIn: !!d.loggedIn }))
      .catch(() => setState({ loading: false, loggedIn: true })); // si falla, no bloquear
  }
  useEffect(checkAuth, []);

  if (state.loading) {
    return <div className="login-wrap"><p className="banner-info">Cargando…</p></div>;
  }
  if (!state.loggedIn) {
    return <LoginScreen onLoggedIn={() => setState({ loading: false, loggedIn: true })} />;
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
