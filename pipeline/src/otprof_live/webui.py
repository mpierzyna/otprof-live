"""Writers of the web app's data formats (docs/DATA_FORMAT.md): forecast cycles (`otprof-live/1`, `write_cycle`), the
climatology (`otprof-live-clim/1`, `write_climatology`) and the index of a data root (`write_index`).

Values are stored as uint16 with scale and offset from their range (`quantize`), NaN as `FILL`. Each directory is
complete once its meta.json exists (written last), and the index lists only complete directories.
"""

import json
import pathlib
import shutil

import numpy as np
import pandas as pd
import xarray as xr

from otprof_live.config import logger

FORMAT = "otprof-live/1"
CLIM_FORMAT = "otprof-live-clim/1"
FILL = 65535
VIOLIN_FILL = 255  # uint8 densities of the violin plots: missing
VIOLIN_LEVELS = 64  # density levels stored (0 .. 63): enough for the width of a violin, and compresses well
VIOLIN_MIN = 0.01  # densities below this fraction of the peak are stored as 0 (the app does not draw them)
CLIM_DIR = "climatology"  # directory of the climatology in a data root

# Climatology: exported variables (the app shows them in this order) and statistics
CLIM_VARIABLES = ["lcn2", "r0", "lsi2"]
CLIM_STATS = ["median", "mean", "p5", "p25", "p75", "p95"]  # the box statistics, also those of the diurnal cycle
# Variables stored as log10 and their linear counterparts in the climatology files: their statistics get `lmean`, the
# log10 of the mean of the linear values (the app's mean when it shows them linearly; `mean` is the mean of the log10,
# the log10 of the geometric mean), and their violins also come in linear values (`violin_linear`). The percentiles of
# the linear values are those of the log10 (stored once, as log10: uint16 keeps their precision).
LINEAR = {"lcn2": "cn2", "lsi2": "si2"}
CLIM_NOTES = """\
## Climatology

Cn² profiles predicted by SQF-H from ERA5 (0.25°, 3-hourly), summarised per calendar month and grid point.
The statistics of each month pool all hours of the day; the diurnal cycle splits them by hour (UTC). The annual and
the diurnal cycle of r0 and σᵢ² are shown as box plots or as violins (the distribution as a kernel density, with the
25th–75th percentile box inside).
The map shows the selected statistic; the profile shows the 25th–75th (dark) and 5th–95th (light) percentile bands.
Months with few years in the sample (listed above the profile) are less representative.
"""


def quantize(vals: np.ndarray) -> tuple[np.ndarray, dict]:
    """`vals` as uint16 with scale and offset from their range (NaN = fill), and the encoding keys of the variable."""
    lo, hi = float(np.nanmin(vals)), float(np.nanmax(vals))
    scale = (hi - lo) / (FILL - 1) or 1.0
    stored = np.where(np.isnan(vals), FILL, np.round((vals - lo) / scale)).astype("<u2")
    return stored, {"dtype": "uint16", "scale": scale, "offset": lo, "fill": FILL, "valid_range": [lo, hi]}


def write_cycle(
    ds: xr.Dataset,
    data_root: pathlib.Path,
    cycle_id: str,
    cycle: pd.Timestamp,
    info: dict[str, str] | None = None,
    notes: str | None = None,
) -> pathlib.Path:
    """Write `ds` as cycle `cycle_id` (directory name) initialised at `cycle` (UTC) below `data_root`, as uint16 with
    scale and offset from the data range per variable. `notes`: markdown of the cycle.

    `ds`: coords lead (hours), z (m above ground, if any variable has it), lat, lon (increasing); variables
    (lead, z, lat, lon) or (lead, lat, lon), NaN = missing."""
    out = data_root / cycle_id
    out.mkdir(parents=True, exist_ok=True)
    variables = {}
    for name, da in ds.data_vars.items():
        dims = ["lead", "z", "lat", "lon"] if "z" in da.dims else ["lead", "lat", "lon"]
        vals = da.transpose(*dims).values.astype(np.float64)
        stored, encoding = quantize(vals)
        var = {
            "long_name": da.attrs.get("long_name", name),
            "units": da.attrs.get("units", ""),
            "dims": dims,
            **encoding,
            "display_range": [float(q) for q in np.nanpercentile(vals, [1, 99])],
        }
        if "z" in dims:  # colour range per height: lcn2 spans orders of magnitude over the column
            q = np.nanpercentile(vals, [1, 99], axis=(0, 2, 3))
            var["display_range_z"] = [[float(a), float(b)] for a, b in q.T]
            var["files"] = [f"{name}_f{int(h):03d}.bin" for h in ds["lead"].values]
            for f, block in zip(var["files"], stored):
                (out / f).write_bytes(block.tobytes())
        else:
            var["file"] = f"{name}.bin"
            (out / var["file"]).write_bytes(stored.tobytes())
        variables[name] = var

    meta = {
        "format": FORMAT,
        "cycle": f"{cycle:%Y-%m-%dT%H:%M:%SZ}",
        "lead_hours": [float(h) for h in ds["lead"].values],
        "lat": [round(float(v), 5) for v in ds["lat"].values],
        "lon": [round(float(v), 5) for v in ds["lon"].values],
        "info": info or {},
        "variables": variables,
    }
    if "z" in ds.coords:
        meta["z_agl"] = [round(float(v), 2) for v in ds["z"].values]
    if notes is not None:
        (out / "notes.md").write_text(notes)
        meta["notes"] = "notes.md"
    # meta.json last: a cycle directory with meta.json is complete
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    return out


def write_index(data_root: pathlib.Path, keep: int | None = None) -> list[str]:
    """`data_root/index.json` with the complete cycles (with meta.json) in `data_root`, newest first, and the
    climatology if there is one. With `keep`, only the newest `keep` cycles are listed and the directories of the
    older ones are deleted."""
    cycles = sorted((f.parent.name for f in data_root.glob("*/meta.json") if f.parent.name.isdigit()), reverse=True)
    if not cycles:
        raise FileNotFoundError(f"No forecast cycle in {data_root}: the app needs at least one (live pipeline, step 3)")
    for old in cycles[keep:] if keep else []:
        logger.info(f"Deleting old cycle {old}")
        shutil.rmtree(data_root / old)
    cycles = cycles[:keep]
    index = {"format": FORMAT, "cycles": cycles, "latest": cycles[0]}
    if (data_root / CLIM_DIR / "meta.json").exists():
        index["climatology"] = f"{CLIM_DIR}/"
    (data_root / "index.json").write_text(json.dumps(index, indent=1))
    return cycles


def to_grid(ds: xr.Dataset) -> xr.Dataset:
    """Increasing lat and lon, heights as the coordinate `z`."""
    if "bottom_top" in ds.dims:
        ds = ds.assign_coords(bottom_top=ds["z_agl"].values).drop_vars("z_agl").rename(bottom_top="z")
    return ds.sortby(["lat", "lon"])


def display_ranges(vals: np.ndarray, stats: list[str], per_z: bool = False) -> dict[str, list]:
    """{stat: [p1, p99]} of `vals` (month, stat, [z,] lat, lon) over all months and cells; `per_z`: one [p1, p99] per
    height (z on axis 2)."""
    out = {}
    for k, s in enumerate(stats):
        q = np.nanpercentile(vals[:, k], [1, 99], axis=(0, 2, 3) if per_z else None)
        out[s] = [[float(a), float(b)] for a, b in q.T] if per_z else [float(a) for a in q]
    return out


def write_violins(violin: xr.Dataset, name: str, out: pathlib.Path, prefix: str) -> dict:
    """The densities of `name` in `violin` as uint8; returns their meta. Of the diurnal cycle (with dim `hour`): one file
    per month `<prefix>_violin_mMM.bin` ([lat][lon][hour][x]); else of the months: one file `<prefix>_violin_month.bin`
    ([month][lat][lon][x])."""
    dims = ["month", "lat", "lon", *(["hour"] if "hour" in violin[name].dims else [])]
    dens = violin[name].transpose(*dims, f"{name}_x").values
    dens = np.where(dens < VIOLIN_MIN, 0, dens)
    stored = np.where(np.isnan(dens), VIOLIN_FILL, np.round(dens * (VIOLIN_LEVELS - 1))).astype("u1")
    meta = {
        "dims": [*dims, "x"],
        "x": [float(v) for v in violin[f"{name}_x"].values],
        "dtype": "uint8",
        "scale": 1 / (VIOLIN_LEVELS - 1),
        "offset": 0.0,
        "fill": VIOLIN_FILL,
    }
    if "hour" not in dims:
        meta["file"] = f"{prefix}_violin_month.bin"
        (out / meta["file"]).write_bytes(stored.tobytes())
        return meta
    meta["files"] = [f"{prefix}_violin_m{m:02d}.bin" for m in violin["month"].values]
    for file, block in zip(meta["files"], stored):
        (out / file).write_bytes(block.tobytes())
    return meta


def write_climatology(
    grid: xr.Dataset,
    diurnal: xr.Dataset,
    out: pathlib.Path,
    violin: xr.Dataset | None = None,
    violin_month: xr.Dataset | None = None,
) -> dict:
    """`grid` (month, stat, lat, lon[, z]), `diurnal` (month, hour, stat, lat, lon) and optionally `violin` (densities
    scaled to a maximum of 1, (month, hour, <var>_x, lat, lon)) and `violin_month` (the same per month, (month, <var>_x,
    lat, lon)) → `out`; returns meta.json. The diurnal cycle of a variable per height (lcn2) is stored per cell
    (lat index * nlon + lon index), each ([month][hour][stat][z]). The linear variables of `LINEAR` (e.g. `cn2`) give the `lmean` of their log10
    variables and their `violin_linear` (`violin_month_linear`). The densities are stored as uint8 in `VIOLIN_LEVELS`
    levels (`VIOLIN_FILL` missing, tails below `VIOLIN_MIN` 0), each violin contiguous: of the diurnal cycle one file per
    month ([lat][lon][hour][x]: ~0.6 MB per variable and month, ~0.13 MB with gzip; the app loads the month shown), of
    the months one file ([month][lat][lon][x])."""
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    variables = {}

    def with_lmean(ds: xr.Dataset, name: str) -> tuple[xr.DataArray, list[str]]:
        """The `CLIM_STATS` of `name`, and `lmean` if its linear variable or `<name>_linear_mean` is in `ds`."""
        da = ds[name].sel(stat=CLIM_STATS)
        if LINEAR.get(name) in ds:
            lmean = np.log10(ds[LINEAR[name]].sel(stat="mean"))
        elif f"{name}_linear_mean" in ds:  # lcn2 of the diurnal cycle, or before the linear Cn2 statistics
            lmean = ds[f"{name}_linear_mean"]
        else:
            return da, CLIM_STATS
        lmean = lmean.expand_dims(stat=["lmean"]).transpose(*da.dims)
        return xr.concat([da, lmean], dim="stat"), [*CLIM_STATS, "lmean"]

    for name in CLIM_VARIABLES:
        has_z = "z" in grid[name].dims
        da, stats = with_lmean(grid, name)
        if LINEAR.get(name) in grid:  # the percentiles of the linear values are those of the log10
            lin = np.log10(grid[LINEAR[name]].sel(stat=["p5", "median", "p95"]))
            diff = float(np.nanmax(np.abs(lin - grid[name].sel(stat=["p5", "median", "p95"]))))
            logger.info(f"{name}: percentiles of the linear values vs. the log10 values: max. difference {diff:.2g} in log10")
        dims = ["month", "stat", "z", "lat", "lon"] if has_z else ["month", "stat", "lat", "lon"]
        vals = da.transpose(*dims).values.astype(np.float64)
        day = np.empty(0)
        day_stats = CLIM_STATS
        if name in diurnal:
            day_da, day_stats = with_lmean(diurnal, name)
            day = day_da.transpose("month", "hour", "stat", *(["z"] if has_z else []), "lat", "lon").values
        # One encoding for the monthly statistics and the diurnal cycle
        stored, encoding = quantize(np.concatenate([vals.ravel(), day.ravel().astype(np.float64)]))
        stored_day = stored[vals.size :].reshape(day.shape)
        stored = stored[: vals.size].reshape(vals.shape)

        var = {
            "long_name": grid[name].attrs.get("long_name", name),
            "units": grid[name].attrs.get("units", ""),
            "dims": dims,
            "stats": stats,
            **encoding,
            "display_ranges": display_ranges(vals, stats),
        }
        if has_z:  # colour range per height: lcn2 spans orders of magnitude over the column
            var["display_ranges_z"] = display_ranges(vals, stats, per_z=True)
            var["files"] = [f"{name}_m{m:02d}.bin" for m in grid["month"].values]
            for f, block in zip(var["files"], stored):
                (out / f).write_bytes(block.tobytes())
        else:
            var["file"] = f"{name}.bin"
            (out / var["file"]).write_bytes(stored.tobytes())
        if day.size and has_z:  # one file per cell ([month][hour][stat][z]): the app loads the cell selected
            day_meta = {"dims": ["month", "hour", "stat", "z"], "stats": day_stats, "cells": f"{name}_diurnal/{{cell}}.bin"}
            var["diurnal_profiles"] = day_meta
            (out / f"{name}_diurnal").mkdir()
            per_cell = np.moveaxis(stored_day, (-2, -1), (0, 1)).reshape(-1, *stored_day.shape[:-2])
            for cell, block in enumerate(per_cell):
                (out / day_meta["cells"].format(cell=cell)).write_bytes(np.ascontiguousarray(block).tobytes())
        elif day.size:
            var["diurnal"] = {"dims": ["month", "hour", "stat", "lat", "lon"], "stats": day_stats, "file": f"{name}_diurnal.bin"}
            (out / var["diurnal"]["file"]).write_bytes(stored_day.tobytes())
        if violin is not None and name in violin:
            var["violin"] = write_violins(violin, name, out, name)
        if violin is not None and LINEAR.get(name) in violin:
            var["violin_linear"] = write_violins(violin, LINEAR[name], out, f"{name}_linear")
        if violin_month is not None and name in violin_month:
            var["violin_month"] = write_violins(violin_month, name, out, name)
        if violin_month is not None and LINEAR.get(name) in violin_month:
            var["violin_month_linear"] = write_violins(violin_month, LINEAR[name], out, f"{name}_linear")
        variables[name] = var

    months = grid.attrs["months"].split()  # "YYYY-MM" of the sample
    years = [sorted({int(s[:4]) for s in months if int(s[5:]) == m}) for m in grid["month"].values]
    first, last = min(months), max(months)
    info = {
        "Model": "SQF-H",
        "Inputs": "ERA5 0.25°, 3-hourly",
        **({"Correction": "nl-oQM"} if grid.attrs.get("otprof_oqm") else {}),
        "Sample": f"{len(months)} months, {first} to {last}",
    }
    (out / "notes.md").write_text(CLIM_NOTES)
    meta = {
        "format": CLIM_FORMAT,
        "months": [int(m) for m in grid["month"].values],
        "hours": [int(h) for h in diurnal["hour"].values],
        "years": years,
        "stats": [*CLIM_STATS, "lmean"],
        "lat": [round(float(v), 5) for v in grid["lat"].values],
        "lon": [round(float(v), 5) for v in grid["lon"].values],
        "z_agl": [round(float(v), 2) for v in grid["z"].values],
        "info": info,
        "notes": "notes.md",
        "variables": variables,
    }
    # meta.json last: a climatology directory with meta.json is complete
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    return meta
