# OTProf live pipelines

Two pipelines write the web app's data (`docs/DATA_FORMAT.md`) into one data root, and `upload.sh` publishes it to the
web server. Both run in this uv environment (`pyproject.toml`, with the `otprof` submodule) and share the package
`otprof_live` (`src/`): the paths (`config`), NetCDF writing (`netcdf`) and the writers of the data formats (`webui`,
`webui_climatology`).

```
pipeline/
  watcher.sh      every hour: forecast/run.sh, then upload.sh
  upload.sh       mirrors data/webui to the web server (rclone)
  forecast/       GFS forecast, every 6 h: run.sh = step 0 prepare, 1 download, 2 predict, 3 convert
  climatology/    ERA5 climatology, one-off: step 1 download (days), run.sh = step 2 to zarr .. step 5 convert
  systemd/        the watcher and the ERA5 download as systemd user services (not enabled by default)
  src/otprof_live/  config.py (paths), netcdf.py, webui.py and webui_climatology.py (format writers)
  data/           OTPROF_DATA, git-ignored
    forecast/       OTPROF_FORECAST_DATA: <cycle>/{1_raw,2_prediction}, running -> <cycle>
    climatology/    OTPROF_CLIM_DATA: 1_raw/ (GRIB, era5.zarr), 3_predictions/, 4_climatology/ (~250 GB)
    webui/          OTPROF_WEBUI_DATA: index.json, <YYYYMMDDHH>/, climatology/
  .env            optional settings (git-ignored), see .env.example
  .rclone.conf    the upload remote (git-ignored): ./upload.sh --config
```

The paths come from the environment or `.env` (relative to `pipeline/`); `uv run python -m otprof_live.config` prints
them. By default everything is below `data/`.

## Forecast (`forecast/`)

```sh
forecast/run.sh                    # one run: the newest complete GFS cycle on AWS, if not processed yet
```

| step | does |
|---|---|
| `step_0_prepare.py` | picks the cycle (newest complete one on AWS, or `--cycle`), creates `data/forecast/<cycle>/` and links it as `running`; resumes an interrupted run; exits 99 if the cycle is processed already |
| `step_1_download_gfs.py` | the 121 lead times (0-120 h) over the NL area → `1_raw/` (resumable) |
| `step_2_predict.py` | SQF-H with output quantile mapping → `2_prediction/preds.nc` (skipped if there) |
| `step_3_convert.py` | → `data/webui/<YYYYMMDDHH>/` (with the forecast as NetCDF for download, ~7 MB) and `index.json` (newest 8 cycles); finishes the run: removes `running`, keeps the newest 8 run directories (~140 MB each) |

`run.sh` takes a lock (one run at a time).

## Upload and watcher

`upload.sh` mirrors `data/webui/` to the remote (rclone), with `--dry-run` to see what would change. It is independent of
both pipelines and does nothing if nothing changed; a lock (`data/webui.lock`) keeps the pipelines from writing to the
data root during an upload.

`watcher.sh` runs `forecast/run.sh` and `upload.sh` every hour (GFS cycles are complete on AWS ~4-5 h after 00, 06, 12,
18 UTC), logs, and keeps going after failed runs:

```sh
./watcher.sh [INTERVAL_S]                                       # foreground, default 3600 s
nohup ./watcher.sh >> data/watcher.log 2>&1 &                   # background
```

To keep it running across logouts and reboots, as a systemd user service (the service files assume the clone at
`~/Projects/otprof-live` and uv at `~/.local/bin`):

```sh
systemctl --user enable --now "$(pwd)/systemd/otprof-watcher.service"
loginctl enable-linger "$USER"                                  # run without being logged in
journalctl --user -u otprof-watcher -f                          # log
```

## Climatology (`climatology/`)

See `climatology/README.md`. In short:

```sh
cd climatology
uv run step_1_download_era5.py --download   # ERA5 from the CDS, days; resumable; usable early (Sobol order)
./run.sh [--delete-grib]                     # steps 2-5 on what is downloaded so far → data/webui/climatology/
```

One-off runs by hand, not part of the watcher, which uploads the new climatology at its next check (or `./upload.sh`).
The download can also run as a service: `systemctl --user enable --now "$(pwd)/systemd/otprof-era5-download.service"`.
