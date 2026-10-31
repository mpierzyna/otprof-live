# ERA5 Cn2 climatology

Steps 1 to 4 come from otprof-research `data/era5_clim`, step 5 converts for the web app. The data are in `CLIM_DATA`
(`OTPROF_CLIM_DATA`, default `pipeline/data/climatology`; see `../README.md`). While the climatology is still computed in
otprof-research, `.env` points there: do not run a step here and its original in otprof-research at the same time.
Differences to the originals: the NL area is a constant in step 1 and the binary land-sea mask of
`otprof_research.inputs` is inlined in step 3, so the steps run in the environment of `pipeline/` without
otprof-research. `run.sh` runs steps 2 to 5 (an update from what is downloaded so far); paths below are relative to
`CLIM_DATA`.

ERA5-based Cn2 climatology: 3-hourly ERA5 over the NL training area from 2005 on, Cn2 profiles, Fried parameter and
scintillation index predicted from it with the published SQF-H of `otprof` (trained on `data/wrf_cn2_rev02`), and
their climatology.

## Pipeline

```bash
uv run step_1_download_era5.py              # plan, download order and estimated size only
uv run step_1_download_era5.py --download   # CDS → 1_raw/cds/{pl,sl}/<YYYY>_<MM>-<MM>_<i>.grib (resumable)
uv run step_2_to_zarr.py [--delete-grib]    # complete months → 1_raw/era5.zarr; run any time during the download
uv run step_3_predict.py [--device cuda:0]  # months of the store → 3_predictions/predictions.zarr; any time after step 2
uv run step_4_climatology.py                # statistics of the predicted months → 4_climatology/*.nc
uv run step_5_convert_webui.py              # 4_climatology → WEBUI_DATA/climatology/ (web app), listed in index.json
```

- **step_1_download_era5.py**: 3-hourly ERA5 (00, 03, ..., 21 UTC) 2005-01 .. 2026-06 (last month of final ERA5) from
  the Copernicus Climate Data Store with `otprof.sources.era5_cds` (needs a CDS account, `~/.ecmwfdatastoresrc` and
  the licences of `reanalysis-era5-pressure-levels` and `-single-levels` accepted). Area and variables as the NL
  training data (`area` of `nl` in `../wrf_cn2_rev02/params.yaml`, `era5.VARIABLES`). The 86 quarters are downloaded
  one by one in the order of a scrambled Sobol sequence over (year, quarter) (`order_quarters_sobol`, fixed seed), so a
  usable sample spread over years and seasons is there early: after 16 quarters 14 of the 22 years and each quarter
  4 times, after 32 quarters all years and each quarter 8 times. 5 requests per quarter (`era5_cds.download` with one block of times per quarter;
  pressure levels: 2, 2, 2, 1 variables x 3 months, the most within the 60 000-field cost limit; surface: 1),
  446 requests, ~29 GB GRIB. The CDS runs the requests of one user one at a time and its run time scales with the
  fields (~1 min per 1000 fields on 2026-10-27). The months in `HOURLY` (2010-08, 2014-03, 2017-04, 2023-12) were
  downloaded hourly, 5 requests per month, before the switch to 3-hourly on 2026-10-28; their quarters request only
  the other months (e.g. `pl/2014_01-02_<i>.grib`), and are the first blocks. The plan is kept in
  `1_raw/cds/jobs.json`, where `era5_cds.fetch` finds the files.
- **step_2_to_zarr.py**: `era5_cds.fetch` month by month → one zarr store in the ARCO layout of `era5.fetch`: ARCO names,
  units and all 37 levels, like `wrf_cn2_rev02/data/nl/1_raw/era5/pl/*.nc`; only the time window and the 3-hourly
  time step differ (the `HOURLY` months are read at the same hours). Converts the months whose GRIB files are complete
  and skips the others; months not written yet are NaN in the store. `list_months_in_store()` lists the months written,
  `open_store()` opens only those. `--delete-grib` deletes a GRIB file once all its months are in the store.

- **step_3_predict.py**: per month of the ERA5 store not predicted yet: `era5_cds.standardize` → `make_inputs` of
  `otprof_research.inputs` (binary land-sea mask, as everywhere in research) → `otprof.predict.predict` with the
  published SQF-H (`sqf_h.HF_REPO_ID` at `HF_REVISION`), output quantile mapping on, at the 99 default heights (8 m to
  ~29 km, coordinate `z_agl`). Keeps `lcn2` per height and `r0` [cm], `lsi2` per profile (1550 nm, plane wave;
  `QKE`, `TSQ`, `EL_PBL` are dropped). Same time axis as the ERA5 store; months not predicted yet are NaN;
  `list_months_predicted()` lists the months written, `open_predictions()` opens only those. ~25 s per month on the
  Quadro P5000 (torch 2.14 cu126, see `pyproject.toml`; ~2 min on 96 CPUs), ~2 h for all 258 months.
- **step_4_climatology.py**: `lcn2`, `cn2` (= 10^`lcn2`), `r0`, `si2` (= 10^`lsi2`) and `lsi2` over the predicted months (the log10 variables and their linear values each from the samples: same percentiles, different moments): `n`, `mean`, `std`,
  `min`, `max`, `median`, `iqr` and the percentiles 0.01, 0.05, 0.1, 0.5, 2.5, 5, 25, 75, 95, 97.5, 99.5, 99.9, 99.95,
  99.99 (dim `stat`; the low end mirrors the high end), plus
  `lcn2_linear_mean` (log10 of the mean linear Cn2; the `mean` of `lcn2` is the log10 geometric mean). Per grid point
  (`grid_<grouping>.nc`) and pooled over the domain (`domain_<grouping>.nc`), for the groupings `all`, `season`,
  `month` and `hour` (UTC). The diurnal cycle of `r0`, `si2`, `lsi2` per grid point and calendar month is in
  `grid_month_hour.nc` (dims month, hour, stat, lat, lon; lcn2 also, per height, with `lcn2_linear_mean`), with
  box-plot statistics: `n`, `mean`, `p5`, `p25`,
  `median`, `p75`, `p95`, `iqr` (box p25 .. p75, whiskers p5 .. p95), and in `grid_month_hour_violin.nc` the same as
  distributions for violin plots: histograms of `r0` and `lsi2` in 100 bins over the range of the variable in all data
  and of the linear `si2` in 400 bins up to its 99.9th percentile (the far tail left out),
  smoothed with a Gaussian of Silverman's bandwidth per month, hour and grid point and cut to the range of the data of
  each violin, scaled to a maximum of 1 per violin; in `grid_month_violin.nc` the same per calendar month (all hours),
  for violin plots of the annual cycle.
  Run again when more months are predicted; the months used are in the attribute `months`.
  During the download these are a Sobol sample of the years (step 1), so early statistics per calendar month rest on
  few years.
- **step_5_convert_webui.py**: `grid_month.nc` and `grid_month_hour.nc` → the web app's climatology
  (`otprof-live-clim/1`, `docs/DATA_FORMAT.md`, writer `otprof_live.webui`) in `WEBUI_DATA/climatology/`: per calendar month the median, mean,
  p5, p25, p75, p95 of lcn2, r0 and lsi2, for lcn2 and lsi2 plus `lmean` (log10 of the mean of cn2, si2: the mean
  the app shows in its linear scale), the diurnal cycle of lcn2 (per grid point), r0 and lsi2, and violins of the diurnal and the annual cycle of r0 and lsi2 (of lsi2 also of the
  linear si2). Adds `"climatology"` to `WEBUI_DATA/index.json`; the live pipeline keeps it there and its step 4 uploads the
  directory with the cycles.

## ERA5 source: ARCO vs. CDS (checked 2026-10-27)

ARCO-ERA5 (the source of the training data, `era5.fetch`) stores one time step of the whole globe per chunk: 20 years
hourly over NL would download ~217 TB (~25 days at 100 MB/s) for 151 GB of data (3-hourly: a third of
that). The CDS cuts the area on the server (hourly ~85 GB GRIB, 3-hourly ~29 GB), at the cost of queueing a few hundred
to a thousand requests.

CDS (GRIB, via `era5_cds.open_grib`) equals ARCO on 2017-01-15 over NL for all 25 variables: identical grid, levels
and times; differences at the GRIB 16-bit packing precision (relative ≤ 2.4e-4, e.g. 0.002 m/s wind, 0.001 K, 34 J m-2
of 6.8e5 for the accumulated latent heat flux), the same in every hour. The fields CDS delivers as forecasts
(accumulated `bld`, `slhf`, mean `avg_snswrf`, `zust`) match ARCO in all 24 hours, so their validity times agree.

## ERA5 source: Google ARCO vs. Earth Data Hub (checked 2026-10-27)

The Earth Data Hub (EDH, DestinE) ERA5 zarr stores were evaluated as an alternative to ARCO-ERA5
(`gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3`) and dropped:

|                       | ARCO-ERA5                                   | EDH (`era5-pressure-levels-v0`, `era5-single-levels-atmosphere-v0`) |
|-----------------------|---------------------------------------------|---------------------------------------------------------------------|
| Access                | anonymous (`gs://`, gcsfs)                  | API key (`https://edh:<key>@data.earthdatahub.destine.eu/...`)        |
| Pressure levels       | 37                                          | **19**: 1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10, 5, 1 hPa |
| Names                 | long CF names (`temperature`, ...)          | GRIB short names (`t`, `t2m`, `zust`, `ishf`, ...), dims `valid_time`, `isobaricInhPa` |
| Chunks                | 1 time step × whole globe (× 37 levels)     | 1440 h (pl) / 1080 h (sfc) × 60 × 60 points (× 1 level)              |
| Download for an area  | whole globe per time step                   | only the 15° tiles of the area, but whole 45–60 day blocks           |
| Time range            | 1940 → a few months behind real time        | 1940 → ~2 weeks behind real time                                     |

- **Blocker**: 15 of the 31 levels of `otprof.schema.P_LEVELS_HPA` are missing in EDH (975, 950, 900, 875, 825, 800,
  775, 750, 650, 550, 450, 350, 225, 175, 125 hPa), mostly in the boundary layer. Inputs on the training levels would
  need vertical interpolation and would no longer match the training data. No EDH store with 37 levels or model
  levels was found (store names are not listable).
- All surface fields of `era5.VARIABLES` exist in EDH except `mean_surface_net_short_wave_radiation_flux`
  (would be `ssr / 3600`); the surface geopotential is `z`, clashing with the pressure-level `z`.
- The store URL with the API key ends up in the dataset `encoding` and would have to be removed before writing.
- For long contiguous time series over a small area (like this climatology) EDH would download far less than ARCO;
  worth revisiting if EDH adds the missing levels.
