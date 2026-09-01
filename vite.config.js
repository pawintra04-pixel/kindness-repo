import { defineConfig } from "vite"

// The app is a single static index.html (the approved visual source of truth)
// plus ES modules under /src that provide the Firestore-backed data layer.
export default defineConfig({
  server: {
    // No fixed port / strictPort: if the default is busy (e.g. a stale dev
    // server), Vite automatically falls back to the next available port and
    // the v0 preview auto-detects it, so startup never fails with
    // "Port 5173 is already in use".
    host: true,
    allowedHosts: true,
  },
  build: {
    target: "es2020",
  },
})
