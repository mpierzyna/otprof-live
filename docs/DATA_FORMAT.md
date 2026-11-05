# Data format `otprof-live/1`

The web app reads only static files below one data root (`dataUrl` in `web/public/config.json`, default `data/`).
Nothing about the grid, the heights, the lead times or the variables is fixed in the app: everything comes from the
files described here. `pipeline/src/otprof_live/webui.py` (`write_cycle`) is the reference writer.

```
data/
  index.json                 list of the available forecast cycles
  2026102300/                one directory per cycle (any name, listed in index.json)
    meta.json                grid, heights, lead times, variables, files
    lcn2_f000.bin ...        binary arrays (one file per lead time for variables with heights)
    r0.bin, lsi2.bin         binary arrays (all lead times in one file for variables without heights)
    notes.md                 optional notes for this cycle (see meta.json "notes")
    otprof-live_<cycle>_EXPERIMENTAL.nc   optional, the forecast as NetCDF for download (see meta.json "download")
  climatology/               optional climatology (format otprof-live-clim/1, see below)
```

## `index.json`

```json
{
  "format": "otprof-live/1",
  "cycles": ["2026102300", "2026102218"],
  "latest": "2026102300"
}
```

- `cycles`: directory names, newest first. The app offers them in a selector.
- `latest`: the cycle shown by default (optional, default: the first in `cycles`).
- `climatology`: directory of the climatology (optional, e.g. `"climatology/"`). If set, the app shows the tabs
  *Live forecast* and *Climatology*.

## `<cycle>/meta.json`

```json
{
  "format": "otprof-live/1",
  "cycle": "2026-10-23T00:00:00Z",
  "lead_hours": [0, 1, 2, 120],
  "lat": [50.25, 50.5],
  "lon": [2.75, 3.0],
  "z_agl": [8.0, 26.0],
  "info": {"Model": "SQF-H (wrf_pl)", "Inputs": "GFS 0.25°", "Correction": "nl-oQM"},
  "notes": "notes.md",
  "download": {"file": "otprof-live_2026102300_EXPERIMENTAL.nc", "bytes": 6844088},
  "variables": {
    "lcn2": {
      "long_name": "log10 Cn2", "units": "log10(m^-2/3)",
      "dims": ["lead", "z", "lat", "lon"],
      "dtype": "uint16", "scale": 0.0001, "offset": -20.0, "fill": 65535,
      "valid_range": [-19.2, -12.9], "display_range": [-17.5, -14.0],
      "display_range_z": [[-15.1, -13.2], [-15.6, -13.8]],
      "files": ["lcn2_f000.bin", "lcn2_f001.bin"]
    },
    "r0": {
      "long_name": "Fried parameter r0", "units": "cm",
      "dims": ["lead", "lat", "lon"],
      "dtype": "uint16", "scale": 0.001, "offset": 0.0, "fill": 65535,
      "file": "r0.bin"
    }
  }
}
```

| key | meaning |
|---|---|
| `cycle` | forecast initialisation, ISO 8601 UTC. The valid time of lead `h` is `cycle + h` hours. |
| `lead_hours` | lead times [h], increasing. Any spacing. |
| `lat`, `lon` | cell centres [degrees north / east], increasing. Any (also irregular) spacing; cell edges are the midpoints. |
| `z_agl` | heights [m above ground], increasing. Needed if any variable has the dimension `z`. |
| `info` | optional, shown as key-value pairs in the app. |
| `notes` | optional, file name of the markdown notes of this cycle, shown after the global notes. |
| `download` | optional, a file of this cycle the app offers for download (`file`, size in `bytes`), after a disclaimer. The live pipeline writes the forecast as CF NetCDF: `lcn2` (time, z, lat, lon), `r0`, `lsi2` (time, lat, lon), float32, compressed, lcn2 rounded to 0.001, licence CC BY-SA 4.0. |
| `variables` | the fields. The app shows them in this order. |

Per variable:

| key | meaning |
|---|---|
| `dims` | `["lead", "z", "lat", "lon"]` (profiles) or `["lead", "lat", "lon"]` (column values such as r0, lsi2). |
| `dtype` | `"uint16"` or `"float32"`, little-endian. |
| `scale`, `offset` | value = `offset + scale * stored` (optional for float32, default 1 and 0). |
| `fill` | stored value of missing data (uint16; for float32, NaN is missing). Missing cells are transparent. |
| `files` | one file per lead time, each `[z][lat][lon]` (or `[lat][lon]`), in the order of `lead_hours`. |
| `file` | alternatively one file with all lead times, `[lead][z][lat][lon]` (or `[lead][lat][lon]`). |
| `long_name`, `units` | optional, for labels (`web/public/config.json` can override them). |
| `valid_range` | optional, [min, max] of the data; profile axis range. |
| `display_range` | optional, colour scale range (e.g. 1st to 99th percentile). `config.json` can override it. |
| `display_range_z` | optional, for variables with `z`: one [min, max] per height, for maps with a colour scale per height. |

Arrays are C order (last dimension fastest), without header. Cells that are missing at all lead times (outside the
domain) cannot be selected in the app.

## Climatology (`otprof-live-clim/1`)

Statistics per calendar month, written by `pipeline/src/otprof_live/webui.py` (`write_climatology`, run by `pipeline/climatology/step_5_convert_webui.py`). `climatology/meta.json` is like a cycle's
`meta.json` (`lat`, `lon`, `z_agl`, `info`, `notes`, `variables` with the same encoding keys), without `cycle` and
`lead_hours`; the time slider steps through the months:

```json
{
  "format": "otprof-live-clim/1",
  "months": [1, 2, 12],
  "hours": [0, 3, 6, 9, 12, 15, 18, 21],
  "years": [[2014], [2014], [2023]],
  "stats": ["median", "mean", "p5", "p25", "p75", "p95", "lmean"],
  "variables": {
    "lcn2": {
      "dims": ["month", "stat", "z", "lat", "lon"], "stats": ["median", "mean", "p5", "p25", "p75", "p95", "lmean"],
      "dtype": "uint16", "scale": 0.0001, "offset": -22.2, "fill": 65535, "valid_range": [-22.2, -13.0],
      "display_ranges": {"median": [-17.5, -14.0]}, "display_ranges_z": {"median": [[-15.8, -14.1]]},
      "files": ["lcn2_m01.bin", "lcn2_m02.bin"],
      "diurnal_profiles": {"dims": ["month", "hour", "stat", "z"], "stats": ["median", "mean", "p5", "p25", "p75", "p95", "lmean"], "cells": "lcn2_diurnal/{cell}.bin"}
    },
    "r0": {
      "dims": ["month", "stat", "lat", "lon"], "stats": ["median", "mean", "p5", "p25", "p75", "p95"],
      "file": "r0.bin",
      "diurnal": {"dims": ["month", "hour", "stat", "lat", "lon"], "stats": ["median", "mean", "p5", "p25", "p75", "p95"], "file": "r0_diurnal.bin"}
    }
  }
}
```

| key | meaning |
|---|---|
| `months` | calendar months (1 to 12), the steps of the time axis. |
| `hours` | hours [UTC] of the diurnal cycle. |
| `years` | per month, the years in the sample (shown in the app: months from few years are less representative). |
| `periods` | optional, statistics of one hour per day besides those of all hours (`day`, `night`): `local_hour` the local time asked for, `utc_hour` the hour of `hours` nearest to it and used, `utc_offset` local time − UTC (no daylight saving). With 3-hourly data `day` is 12 UTC and `night` 00 UTC, in the Netherlands (UTC+1) 13:00 and 01:00 local time. If set, the app offers *Global*, *Day*, *Night*; see `periods` per variable. |
| `stats` | all statistics, in the order the app offers them. `median`, `mean`, `pN` (Nth percentile); `lmean` is the log10 of the mean of the linear values of a log10 variable (lcn2, lsi2; `mean` is the mean of the log10 values, the log10 of the geometric mean). The app shows `lmean` as the mean when it shows such a variable linearly (10^value); the percentiles are the same in both scales. The app needs `p5`, `p25`, `p75`, `p95` for the bands. |

Per variable, in addition to the cycle keys:

| key | meaning |
|---|---|
| `stats` | the statistics of this variable, in the order of the `stat` dimension of its files. |
| `files` | one file per month, each `[stat][z][lat][lon]` (variables with `z`). |
| `file` | alternatively one file `[month][stat][lat][lon]` (variables without `z`). |
| `display_ranges`, `display_ranges_z` | per statistic, the colour scale range (and per height), over all months. |
| `diurnal` | optional diurnal cycle, `[month][hour][stat][lat][lon]` with its own `stats`, same encoding as the variable. |
| `diurnal_profiles` | optional diurnal cycle of a variable with `z` (lcn2), with its own `stats`, same encoding as the variable: one file per cell, `cells` with `{cell}` for the cell index (lat index × number of lons + lon index), each `[month][hour][stat][z]` (~130 KB; the app loads the cell selected). |
| `violin` | optional distributions of the diurnal cycle for violin plots: densities scaled to a maximum of 1 per month, hour and cell at the bin centres `x` of the variable, with their own encoding (`dtype` `uint8`, `scale`, `offset`, `fill`); `files`: one per month, each `[lat][lon][hour][x]` (each violin contiguous: compresses well). The app loads the month shown when the violins are on (~0.6 MB per variable and month, ~0.13 MB with gzip). |
| `violin_linear` | optional, of a log10 variable: the same of its linear values (`x` linear, 10^value), estimated in linear space; the app uses them when it shows the variable linearly. |
| `violin_month` | optional distributions per month (all hours) for violin plots of the annual cycle: as `violin`, but one `file` `[month][lat][lon][x]`. |
| `violin_month_linear` | optional, of a log10 variable: the same of its linear values. |
| `periods` | optional, per period the `files` or `file`, `violin_month` and `violin_month_linear` of that period, which replace those of the variable. Same statistics, encoding and `display_ranges` as all hours (over all periods), so that colours compare. The diurnal cycle is the same for all. |
| `csv` | optional, of a variable with `z` (lcn2): its profiles for download. `periods`: the periods included; `cells`: one zip per month and cell, with `{month}` (two digits) and `{cell}`, each with one CSV file per period, `otprof-clim_cn2_lat<lat>_lon<lon>_m<MM>_<period>_EXPERIMENTAL.csv`. Columns: `z_agl_m` (one row per height), `n` (time steps), `cn2_<stat>` (linear Cn2 [m^-2/3]: `mean`, `std`, `min`, the percentiles `p0.01` .. `p99.99` with `median`, `max`, `iqr`), `lcn2_mean`, `lcn2_std` (of log10 Cn2). Pre-compressed, ~22 KB each (~190 MB for all months and cells). |

## Serving

Plain files, so any static web server works. Recommended for nginx: gzip for `application/json` and
`application/octet-stream` (or pre-compressed `.gz` files with `gzip_static on`), and short caching for `index.json`
(it changes every cycle) while the cycle directories never change once published. Write a cycle directory completely
before adding it to `index.json`.
