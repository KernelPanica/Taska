import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const api = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["development"] },
  server: {
    port: 5173,
    proxy: { "/api": api, "/health": api, "/dev/yourspace": api },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
