import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import LoginScreen from "./LoginScreen.jsx";
import "./styles.css";

// Interceptor global de sesión expirada: si CUALQUIER petición a la API
// devuelve 401 (la cookie caducó mientras usábamos la app), avisamos al Root
// para volver al login, en vez de dejar que los fetch fallen en silencio.
// Se instala una sola vez, envolviendo window.fetch.
let onSessionExpired = () => {};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : input?.url || "";
  // Ignoramos los 401 del propio flujo de auth (login fallido, etc.).
  if (res.status === 401 && !url.includes("/api/auth/")) {
    onSessionExpired();
  }
  return res;
};

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
      // Si el status falla, mostramos el login: el backend protege todo igual,
      // así que asumir "logueado" solo daría una UX confusa (fetch en error).
      .catch(() => setState({ loading: false, loggedIn: false }));
  }
  useEffect(checkAuth, []);

  // Registra el handler de sesión expirada: al recibir un 401, vuelve al login.
  useEffect(() => {
    onSessionExpired = () => setState({ loading: false, loggedIn: false });
    return () => {
      onSessionExpired = () => {};
    };
  }, []);

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
