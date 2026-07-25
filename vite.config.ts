import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  build: {
    rollupOptions: {
      // Two entry points: the app, and the small always-on-top popover the
      // tray opens for a pinned note.
      input: {
        main: "index.html",
        pinned: "pinned.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching Rust sources and build output.
      //
      // `target/` sits at the repo root rather than under `src-tauri/`,
      // because this is a Cargo workspace (so `envy-core` can be its own
      // crate). That puts it inside Vite's project root, and Vite's watcher
      // dies with EBUSY the moment Cargo holds a lock on a build script
      // executable it's trying to watch. The stock Tauri config only ignores
      // `src-tauri/**`, which is correct only when `target/` lives inside it.
      ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**"],
    },
  },
}));
