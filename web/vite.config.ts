import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type Connect, defineConfig, type Plugin } from "vite";

// Development data (pipeline/make_example.py) served at /data/ by the dev and preview servers only, so it never ends up
// in the build: in production the web server delivers the pipeline output at the same path.
const DEV_DATA = resolve(__dirname, process.env.OTPROF_LIVE_DATA ?? "../dev-data");
const TYPES: Record<string, string> = { ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

function devData(): Plugin {
  const serve = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use("/data", (req, res, next) => {
      const path = resolve(DEV_DATA, `.${decodeURIComponent((req.url ?? "/").split("?")[0])}`);
      if (!path.startsWith(DEV_DATA) || !existsSync(path) || !statSync(path).isFile()) return next();
      res.setHeader("Content-Type", TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream");
      createReadStream(path).pipe(res);
    });
  };
  return { name: "dev-data", configureServer: serve, configurePreviewServer: serve };
}

// Relative asset paths: the built app (dist/) works from any directory of the web server.
// Dev server on another interface (e.g. Tailscale):  npm run dev -- --host <ip>
export default defineConfig({
  base: "./",
  build: { chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  plugins: [devData()],
});
