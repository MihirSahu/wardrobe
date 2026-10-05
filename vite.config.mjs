import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";

export default defineConfig(() => {
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: false } },
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      allowedHosts: ["localhost"],
    },
    plugins: [react(), responsiveImageApi()],
  };
});
