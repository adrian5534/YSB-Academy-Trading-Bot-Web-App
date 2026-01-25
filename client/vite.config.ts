import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:8787",
        changeOrigin: true,
      },
      "/ws": {
        target: (process.env.VITE_BACKEND_URL || "http://localhost:8787").replace("http", "ws"),
        ws: true,
      },
    },
  },
});
