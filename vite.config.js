import { defineConfig } from "vite"

// The app is a single static index.html (the approved visual source of truth)
// plus ES modules under /src that provide the Firestore-backed data layer.
export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
  },
  build: {
    target: "es2020",
  },
})
