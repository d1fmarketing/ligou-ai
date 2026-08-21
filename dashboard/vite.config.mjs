import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function dashboardViteConfig({ command }) {
  return {
  base: process.env.LIGOU_BASE ?? "/dashboard/",
  envDir: command === "build" ? false : ".",
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
  };
}

export default defineConfig(dashboardViteConfig);
