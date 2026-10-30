# OTProf live pipelines

Two pipelines write the web app's data (`docs/DATA_FORMAT.md`) into one data root, which the live pipeline uploads to
the web server. Both run in this uv environment (`pyproject.toml`, with the `otprof` submodule) and share the package
`otprof_live` (`src/`): the paths (`config`) and the writers of the data formats (`webui`). otprof-research is not
needed.

```
pipeline/
  live/           GFS forecast, every 6 h: run.sh = step 0 prepare, 1 download, 2 predict, 3 convert, 4 upload
  climatology/    ERA5 climatology, now and then: step 1 download (days), run.sh = step 2 to zarr .. step 5 convert
  src/otprof_live/  config.py (paths), webui.py (format writers)
  data/           OTPROF_DATA, git-ignored
    live/           OTPROF_FORECAST_DATA: <cycle>/{1_raw,2_prediction}, running -> <cycle>, run.log
    climatology/    OTPROF_CLIM_DATA: 1_raw/ (GRIB, era5.zarr), 3_predictions/, 4_climatology/ (~250 GB)
    webui/          OTPROF_WEBUI_DATA: index.json, <YYYYMMDDHH>/, climatology/ (uploaded by live step 4)
  .env            optional settings (git-ignored), see .env.example
  .rclone.conf    the upload remote (git-ignored): bash live/step_4_upload.sh --config
```

The paths come from the environment or `.env` (relative to `pipeline/`); `uv run python -m otprof_live.config` prints
them. By default everything is below `data/`. During development the climatology can stay where it was computed:
`OTPROF_CLIM_DATA=../../otprof-research/data/era5_clim` in `.env`.

## Live forecast (`live/`)

```sh
live/run.sh                        # one run: the newest complete GFS cycle on AWS, if not processed yet
```

| step | does |
|---|---|
| `step_0_prepare.py` | picks the cycle (newest complete one on AWS, or `--cycle`), creates `data/live/<cycle>/` and links it as `running`; resumes an interrupted run; exits 99 if the cycle is processed already |
| `step_1_download_gfs.py` | the 121 lead times (0-120 h) over the NL area → `1_raw/` (resumable) |
| `step_2_predict.py` | SQF-H with output quantile mapping → `2_prediction/preds.nc` (skipped if there) |
| `step_3_convert.py` | → `data/webui/<YYYYMMDDHH>/` and `index.json` (newest 8 cycles); finishes the run: removes `running`, keeps the newest 8 run directories (~140 MB each) |
| `step_4_upload.sh` | mirrors `data/webui/` to the remote (rclone); independent of the run, a failure is repeated next time |

`run.sh` takes a lock (one run at a time) and is meant for cron, e.g. every 30 minutes (GFS cycles appear ~4-5 h after
00, 06, 12, 18 UTC):

```
*/30 * * * * /path/to/pipeline/live/run.sh >> /path/to/pipeline/data/live/run.log 2>&1
```

## Climatology (`climatology/`)

See `climatology/README.md`. In short:

```sh
cd climatology
uv run step_1_download_era5.py --download   # ERA5 from the CDS, days; resumable; usable early (Sobol order)
./run.sh [--delete-grib]                     # steps 2-5 on what is downloaded so far → data/webui/climatology/
```

The next live run uploads the new climatology (or `bash live/step_4_upload.sh`).
