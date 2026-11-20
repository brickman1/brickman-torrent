import { defineConfig } from 'vite';

// Tauri expects a fixed dev port; the same build runs in a plain browser
// (no Tauri runtime) and inside the webview.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
