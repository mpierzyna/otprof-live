# OTProf live

Static web app showing OTProf (SQF-H) optical turbulence forecasts: a map of log10 Cn², r0 or the scintillation index
with time and height sliders, the vertical profile and the time-height evolution at a clicked point, and markdown notes.
A second tab shows the climatology (ERA5-driven SQF-H statistics per calendar month and grid point, with the annual and
diurnal cycle at the clicked point) if the data root has one (`pipeline/climatology`, step 5).

No code runs on the server: a forecast pipeline writes static files (`docs/DATA_FORMAT.md`), and any static web
server (nginx) delivers them together with the built app. All interaction happens in the browser.

```
web/        the app (Vite + TypeScript, MapLibre GL, d3)
pipeline/   the pipelines writing the data (pipeline/README.md): live/ GFS forecasts, climatology/ ERA5 climatology
docs/       DATA_FORMAT.md: the contract between pipeline and app
deploy/     nginx.conf (server block), update.sh (pull and rebuild, run from cron)
```

## Development

```sh
cd web && npm install
OTPROF_LIVE_DATA=../pipeline/data/webui npm run dev   # http://localhost:5173, the pipeline's data served at /data/
npm run dev -- --host <tailscale ip> # reachable over Tailscale
npm run build && npm run preview -- --host <tailscale ip>   # production build, http://<ip>:4173
```

For looking at the app from another device (phone), use the preview: the dev server reloads the page whenever its
live-reload connection drops (screen lock, app switch, network change) or a source file changes.

## Deploy

The server runs a clone of this repository. `Dockerfile` builds the app in a Node stage and puts `web/dist/` with
`deploy/nginx.conf` into an unprivileged nginx image. `compose.yaml` runs it with the forecast data mounted read-only
at `/data/`. `deploy/update.sh` pulls the deployed branch and, if there are new commits, rebuilds the image and
replaces the container. A failed build keeps the running version, and the next run retries.

```sh
git clone <repo url> /srv/otprof_live && cd /srv/otprof_live
cat > .env <<EOT                       # all optional; defaults in brackets
OTPROF_LIVE_DATA=/srv/otprof_data      # data directory written by the pipeline [./data]
OTPROF_LIVE_BIND=127.0.0.1             # interface to listen on [127.0.0.1]
OTPROF_LIVE_PORT=8080                  # host port [8080]
OTPROF_LIVE_BRANCH=main                # branch to deploy [main]
EOT
deploy/update.sh --force               # first build and start
crontab -e                             # then add:
# */5 * * * * cd /srv/otprof_live && flock -n .update.lock deploy/update.sh >> update.log 2>&1
# 0 4 * * 1   cd /srv/otprof_live && flock .update.lock deploy/update.sh --force >> update.log 2>&1   # base image updates
```

The user running the cron job needs Docker access. TLS is not part of the image: put the container behind the host's
reverse proxy (or `tailscale serve`), or set `OTPROF_LIVE_BIND=0.0.0.0` for plain HTTP. Rollback:
`git checkout <commit> && docker compose up -d --build`. This stays until the next new commit on the branch.

`config.json`, `notes.md` and `disclaimer.md` (in `web/public/`) are part of the image: edits deploy with the next
push. Per-cycle notes come from the cycle's `meta.json` (`"notes"`). Links in the notes like
`[text](#lat=52&lon=5&z=1000&t=12&var=r0)` set the view.

Without Docker: `cd web && npm ci && npm run build`, copy `web/dist/` to the web root, put the data in
`<web root>/data/` and use `deploy/nginx.conf` as the server block (adjust `root` and `listen`). It sets the MIME
types, compression, caching and CSP that the app needs.

Local test of the image with the example data:
`OTPROF_LIVE_DATA=./pipeline/data/webui docker compose up --build`, then open http://localhost:8080.

The app needs WebGL (MapLibre). The basemap is Natural Earth 1:10m, cut to the region in
`web/scripts/make_basemap.mjs` (widen it for larger domains).
