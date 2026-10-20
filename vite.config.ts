import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Настройки под Tauri: фиксированный порт, без очистки экрана, сборка под WebView.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
