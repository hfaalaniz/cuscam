import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Durante desarrollo, /api se redirige al backend Express (puerto 3000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
});
