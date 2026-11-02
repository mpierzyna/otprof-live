# OTProf live

Static web app showing OTProf (SQF-H) optical turbulence forecasts over the Netherlands, driven by GFS:

- maps of Cₙ², r₀ and the scintillation index σᵢ² over time and height
- vertical profiles and time-height plots at any point
- forecast runs for download as NetCDF
- an ERA5-based climatology for comparison

No code runs on the server: the pipelines write static files (`docs/DATA_FORMAT.md`), and any static web server
(nginx) delivers them together with the built app. All interaction happens in the browser.

```
web/          the app (Vite + TypeScript, MapLibre GL, d3)
  content/    texts of the app as markdown (title, disclaimer, about, ...), see web/content/README.md
  public/     config.json: variables (labels, units, colour maps), defaults of the view
pipeline/     the pipelines writing the data (pipeline/README.md): live/ GFS forecasts, climatology/ ERA5 climatology
  otprof/     the model (git submodule)
docs/         DATA_FORMAT.md: the contract between pipelines and app
Dockerfile, docker-compose.yml, nginx.conf    the deployment
```

Clone with the submodule (needed for the pipelines only): `git clone --recurse-submodules <repo url>`, or
`git submodule update --init` in an existing clone.

## Development

```sh
cd web && npm install
npm run dev                                   # http://localhost:5173, pipeline/data/webui served at /data/
OTPROF_LIVE_DATA=<data dir> npm run dev       # other data
npm run dev -- --host <tailscale ip>          # reachable over Tailscale
npm run build && npm run preview -- --host <tailscale ip>   # production build, http://<ip>:4173
```

The data come from the pipelines (`pipeline/README.md`); the dev and preview servers serve them at `/data/`, the build
does not contain them. For looking at the app from another device (phone), use the preview: the dev server reloads the
page whenever its live-reload connection drops (screen lock, app switch, network change) or a source file changes.

Texts: edit the markdown in `web/content/` (rendered into `index.html` at build time). Notes of a single forecast run
come from its `meta.json` (`"notes"`). Links like `[text](#lat=52&lon=5&z=1000&t=12&var=r0)` set the view.

## Deploy

The server runs a clone of this repository. `Dockerfile` builds the app in a Node stage and puts `web/dist/` with
`nginx.conf` into an nginx image. `docker-compose.yml` runs it on port 8080 with the data directory `./data` mounted
read-only at `/data/`; the live pipeline fills that directory (`pipeline/live/step_4_upload.sh`, rclone remote
pointing at it).

```sh
git clone <repo url> /srv/docker/otprof_live && cd /srv/docker/otprof_live
docker compose up -d --build                  # first start
git pull --ff-only && docker compose up -d --build   # update: deploys texts, config and app
```

Local changes to the setup (ports, networks) go into `docker-compose.override.yml` (git-ignored), e.g. to reach the
container through a reverse proxy network instead of a published port. TLS is not part of the image: put the container
behind the host's reverse proxy (or `tailscale serve`). Rollback: `git checkout <commit> && docker compose up -d
--build`.

Without Docker: `cd web && npm ci && npm run build`, copy `web/dist/` to the web root, put the data in
`<web root>/data/` and use `nginx.conf` as the server block (adjust `root` and `listen`). It sets the MIME types
(`.nc`, `.md`, `.mjs`), compression, caching and CSP that the app needs.

Local test of the image with the pipeline's data: link or copy `pipeline/data/webui` to `./data`, then
`docker compose up --build` and open http://localhost:8080.

The app needs WebGL (MapLibre). The basemap is Natural Earth 1:10m, cut to the region in
`web/scripts/make_basemap.mjs` (widen it for larger domains); it is generated before `dev` and `build`.
