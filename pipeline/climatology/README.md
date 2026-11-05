# ERA5 Cn2 climatology

Cn2 profiles, Fried parameter r0 and scintillation index predicted with SQF-H (`otprof`) from 3-hourly ERA5 over the NL
area from 2005 on, and their statistics per calendar month and hour, converted for the web app's climatology
tab. The data are in `CLIM_DATA` (`OTPROF_CLIM_DATA`, default `pipeline/data/climatology`, ~250 GB; see
`../README.md`); paths below are relative to it.

Paths, the area, the time window and the hours of day and night (`PERIOD_HOURS_UTC`: align them with local noon and local
midnight for other locations) are in `shared.py`; the steps import from there, not from each other.

## Pipeline

```bash
uv run step_1_download_era5.py              # plan, download order and estimated size only
uv run step_1_download_era5.py --download   # CDS → 1_raw/cds/{pl,sl}/*.grib (days; resumable)
./run.sh [--delete-grib]                    # steps 2 to 5 on what is downloaded so far
```

`run.sh` can run any time during the download: each step processes only the months that are new. The next live run
uploads the result (or `bash ../live/step_4_upload.sh`).

| step | does |
|---|---|
| `step_1_download_era5.py` | ERA5 2005-01 .. 2026-06 (00, 03, .., 21 UTC) from the Copernicus Climate Data Store, same area and variables as the training data of SQF-H; ~430 requests, ~29 GB GRIB. Quarters in the order of a Sobol sequence over (year, quarter), so a sample spread over years and seasons is usable early. The plan is kept in `1_raw/cds/jobs.json`. |
| `step_2_to_zarr.py` | complete months → `1_raw/era5.zarr` (ARCO-ERA5 names, units and levels); `--delete-grib` deletes GRIB files once converted |
| `step_3_predict.py` | SQF-H with output quantile mapping at its 99 heights (8 m to ~29 km) → `3_predictions/predictions.zarr`: `lcn2` per height, `r0` [cm] and `lsi2` per profile (1550 nm, plane wave). `--device cuda:0` for a GPU (~25 s per month). |
| `step_4_climatology.py` | statistics of lcn2, cn2, r0, lsi2 and si2 per grid point → `4_climatology/`: `monthly.nc` (all statistics per calendar month and period: global, day = 12 UTC, night = 00 UTC), `diurnal.nc` (per calendar month and hour), `violins_diurnal.nc`, `violins_month.nc` (densities for violin plots) |
| `step_5_convert_webui.py` | → the web app's climatology (`docs/DATA_FORMAT.md`) in `WEBUI_DATA/climatology/`, listed in `index.json`, with the statistics as two NetCDF files for download |

Step 1 needs a CDS account (`~/.ecmwfdatastoresrc`) with the licences of `reanalysis-era5-pressure-levels` and
`reanalysis-era5-single-levels` accepted. During the download the statistics rest on a sample of the years; the months
used are in the attribute `months` of the step 4 files.

## ERA5 source (checked 2026-10-27)

SQF-H needs the 31 pressure levels of `otprof.schema.P_LEVELS_HPA` and the surface fields of `era5.VARIABLES`. Three
sources were compared for 20 years over the NL area:

|  | CDS (used) | Google ARCO-ERA5 | Earth Data Hub (DestinE) |
|---|---|---|---|
| Access | CDS account, requests queued on the server | anonymous (`gs://gcp-public-data-arco-era5`, zarr) | API key (zarr over https) |
| Pressure levels | 37 | 37 | **19**: 15 of the 31 needed are missing, mostly in the boundary layer |
| Area cut | on the server | no: one chunk = one time step of the whole globe | 15° tiles, but 45–60 day blocks |
| Download for 20 years over NL | ~29 GB GRIB (3-hourly) | ~217 TB (hourly; ~25 days at 100 MB/s) | far less than ARCO |
| Latency to real time | ~5 days (ERA5T; final ERA5 after 2–3 months) | a few months | ~2 weeks |
| Throughput | ~430 requests, run one at a time per user, ~1 min per 1000 fields | limited by bandwidth | limited by bandwidth |

- **CDS** was chosen: it is the only source with all levels that does not download the globe. It equals ARCO (the
  source of the training data) on 2017-01-15 over NL for all 25 variables: identical grid, levels and times;
  differences at the 16-bit GRIB packing precision (relative ≤ 2.4e-4, e.g. 0.002 m/s wind, 0.001 K). The fields the
  CDS delivers as forecasts (accumulated `bld`, `slhf`, mean `avg_snswrf`, `zust`) match ARCO in all 24 hours once
  put on their validity times (`era5_cds.fetch`).
- **ARCO-ERA5** is fine for short periods but not for long time series: its chunking
  forces downloading the whole globe for every time step.
- **Earth Data Hub** was dropped for the missing levels: inputs would need vertical interpolation and would no longer
  match the training data. It also uses GRIB short names (`t`, `zust`; the surface geopotential `z` clashes with the
  pressure-level `z`), lacks `mean_surface_net_short_wave_radiation_flux` (would be `ssr / 3600`), and the store URL
  with the API key ends up in the dataset's `encoding`. Worth revisiting for long series if it adds the missing levels.
