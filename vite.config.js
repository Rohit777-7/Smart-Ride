import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// MAPTILE_* variables are exposed to the browser (map tiles need the key client-side;
// restrict the key to your domains in the MapTiler dashboard).
export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'MAPTILE_'],
  // MapLibre (3D map engine) ships as its own long-cached chunk; the app shell stays small.
  build: {
    chunkSizeWarningLimit: 1100,
    rolldownOptions: { output: { advancedChunks: { groups: [{ name: 'maplibre', test: /node_modules[/\\]maplibre-gl/ }] } } },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
})
