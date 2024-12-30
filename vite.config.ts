import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["janus-gateway"],
  },
  build: {
    commonjsOptions: {
      include: [/janus-gateway/, /node_modules/],
      transformMixedEsModules: true,
    },
    rollupOptions: {
      output: {
        manualChunks: {
          janus: ["janus-gateway"],
        },
      },
    },
  },
});
