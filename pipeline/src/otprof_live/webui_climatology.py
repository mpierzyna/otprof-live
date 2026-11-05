"""Writer of the web app's climatology (`otprof-live-clim/1`, docs/DATA_FORMAT.md) from the statistics of step 4 of the
climatology pipeline, with the statistics as NetCDF files for download.

The directory is written beside its final place (`<out>.part`, not uploaded) and swapped in when complete: an upload
never sees it half written. Inside, meta.json is written last.
"""

import json
import pathlib
import shutil

import numpy as np
import pandas as pd
import xarray as xr

from otprof_live.netcdf import LICENSE, to_netcdf_atomic
from otprof_live.webui import RESOLUTION, quantize

CLIM_FORMAT = "otprof-live-clim/1"
CLIM_VARIABLES = ["lcn2", "r0", "lsi2"]  # exported, the app shows them in this order
CLIM_STATS = ["median", "mean", "p5", "p25", "p75", "p95"]  # the box statistics, also those of the diurnal cycle
# Variables stored as log10 and their linear counterparts in the statistics: they get the statistic `lmean`, the log10
# of the mean of the linear values (the app's mean when it shows them linearly; `mean` is the mean of the log10, the
# log10 of the geometric mean), and their violins also come in linear values. The percentiles of the linear values are
# those of the log10 (stored once, as log10: uint16 keeps their precision).
LINEAR = {"lcn2": "cn2", "lsi2": "si2"}
VIOLIN_FILL = 255  # uint8 densities of the violin plots: missing
VIOLIN_LEVELS = 64  # density levels stored (0 .. 63): enough for the width of a violin, and compresses well
VIOLIN_MIN = 0.01  # densities below this fraction of the peak are stored as 0 (the app does not draw them)

# NetCDF files for download: variables and their rounding, far below the model's error. lcn2 to 0.001 is 0.2 % in Cn2; 3
# significant digits of the linear values are at most ~0.5 % off (`GranularBitRound`: compresses, unlike decimal
# rounding).
DOWNLOADS = {"monthly": "Monthly statistics", "diurnal": "Diurnal cycle"}
DOWNLOAD_VARIABLES = {
    "lcn2": {"least_significant_digit": 3},
    "cn2": {"significant_digits": 3, "quantize_mode": "GranularBitRound"},
    "r0": {"least_significant_digit": 3},
    "si2": {"significant_digits": 3, "quantize_mode": "GranularBitRound"},
    "n": {},
}
DISCLAIMER = (
    "Experimental research data from a machine-learning model (SQF-H) trained on WRF simulations over the Netherlands, "
    "driven by ERA5. Not validated for operational use. Provided as is, without any warranty. Do not base "
    "safety-critical or operational decisions on it."
)


def to_grid(ds: xr.Dataset) -> xr.Dataset:
    """Increasing lat and lon, heights as the coordinate `z`."""
    if "bottom_top" in ds.dims:
        ds = ds.assign_coords(bottom_top=ds["z_agl"].values).drop_vars("z_agl").rename(bottom_top="z")
    return ds.sortby(["lat", "lon"])


def with_lmean(ds: xr.Dataset, name: str) -> xr.DataArray:
    """The `CLIM_STATS` of `name`, and `lmean` if it has a linear variable in `LINEAR`."""
    da = ds[name].sel(stat=CLIM_STATS)
    if name not in LINEAR:
        return da
    lmean = np.log10(ds[LINEAR[name]].sel(stat="mean")).expand_dims(stat=["lmean"]).transpose(*da.dims)
    return xr.concat([da, lmean], dim="stat")


def display_ranges(vals: np.ndarray, stats: list[str], per_z: bool = False) -> dict[str, list]:
    """{stat: [p1, p99]} of `vals` (month, stat, [z,] lat, lon) over all months and cells; `per_z`: one [p1, p99] per
    height (z on axis 2)."""
    out = {}
    for k, s in enumerate(stats):
        q = np.nanpercentile(vals[:, k], [1, 99], axis=(0, 2, 3) if per_z else None)
        out[s] = [[float(a), float(b)] for a, b in q.T] if per_z else [float(a) for a in q]
    return out


def write_violins(violin: xr.Dataset, name: str, out: pathlib.Path, prefix: str) -> dict:
    """The densities of `name` in `violin` as uint8; returns their meta. Of the diurnal cycle (with dim `hour`): one
    file per month `<prefix>_violin_mMM.bin` ([lat][lon][hour][x]: ~0.6 MB per variable and month, ~0.13 MB with gzip;
    the app loads the month shown); else of the months: one file `<prefix>_violin_month.bin` ([month][lat][lon][x])."""
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


def write_months(stem: str, stored: np.ndarray, months: np.ndarray, out: pathlib.Path) -> dict:
    """The statistics of one period (month, stat, [z,] lat, lon): one file per month for a variable with heights, else
    one file; returns their meta."""
    if stored.ndim == 4:
        (out / f"{stem}.bin").write_bytes(stored.tobytes())
        return {"file": f"{stem}.bin"}
    files = [f"{stem}_m{m:02d}.bin" for m in months]
    for file, block in zip(files, stored):
        (out / file).write_bytes(block.tobytes())
    return {"files": files}


def write_diurnal(name: str, stored: np.ndarray, stats: list[str], out: pathlib.Path) -> dict:
    """The diurnal cycle (month, hour, stat, [z,] lat, lon) of a variable; returns its meta. With heights: one file per
    cell (lat index * nlon + lon index), each [month][hour][stat][z], the app loads the cell selected; else one file."""
    if stored.ndim == 5:
        file = f"{name}_diurnal.bin"
        (out / file).write_bytes(stored.tobytes())
        return {"diurnal": {"dims": ["month", "hour", "stat", "lat", "lon"], "stats": stats, "file": file}}
    cells = f"{name}_diurnal/{{cell}}.bin"
    (out / f"{name}_diurnal").mkdir()
    per_cell = np.moveaxis(stored, (-2, -1), (0, 1)).reshape(-1, *stored.shape[:-2])
    for cell, block in enumerate(per_cell):
        (out / cells.format(cell=cell)).write_bytes(np.ascontiguousarray(block).tobytes())
    return {"diurnal_profiles": {"dims": ["month", "hour", "stat", "z"], "stats": stats, "cells": cells}}


def write_variable(
    name: str,
    monthly: xr.Dataset,
    diurnal: xr.Dataset,
    violins_diurnal: xr.Dataset,
    violins_month: xr.Dataset,
    out: pathlib.Path,
) -> dict:
    """The files of a variable; returns its meta. The monthly statistics of all periods and the diurnal cycle share one
    encoding, and the periods their colour ranges, so that they compare."""
    z = ["z"] if "z" in monthly[name].dims else []
    dims = ["stat", *z, "lat", "lon"]
    by_period = with_lmean(monthly, name).transpose("period", "month", *dims)
    stats = [str(s) for s in by_period["stat"].values]
    day = with_lmean(diurnal, name).transpose("month", "hour", *dims).values.astype(np.float64)
    vals = by_period.values.astype(np.float64)
    all_months = vals.reshape(-1, *vals.shape[2:])

    stored, encoding = quantize(np.concatenate([vals.ravel(), day.ravel()]), RESOLUTION.get(name))
    stored_day = stored[vals.size :].reshape(day.shape)
    stored = dict(zip(by_period["period"].values, stored[: vals.size].reshape(vals.shape)))
    months = monthly["month"].values

    var = {
        "long_name": monthly[name].attrs.get("long_name", name),
        "units": monthly[name].attrs.get("units", ""),
        "dims": ["month", *dims],
        "stats": stats,
        **encoding,
        "display_ranges": display_ranges(all_months, stats),
        **write_months(name, stored["global"], months, out),
        **write_diurnal(name, stored_day, stats, out),
    }
    if z:  # colour range per height: lcn2 spans orders of magnitude over the column
        var["display_ranges_z"] = display_ranges(all_months, stats, per_z=True)

    def write_month_violins(violins: xr.Dataset, stem: str) -> dict:
        """The violins per month of `violins`, if it has the variable: `violin_month`, `violin_month_linear`."""
        entry = {}
        if name in violins:
            entry["violin_month"] = write_violins(violins, name, out, stem)
        if LINEAR.get(name) in violins:
            entry["violin_month_linear"] = write_violins(violins, LINEAR[name], out, f"{stem}_linear")
        return entry

    if name in violins_diurnal:
        var["violin"] = write_violins(violins_diurnal, name, out, name)
    if LINEAR.get(name) in violins_diurnal:
        var["violin_linear"] = write_violins(violins_diurnal, LINEAR[name], out, f"{name}_linear")
    var |= write_month_violins(violins_month, name)
    var["periods"] = {
        period: {
            **write_months(f"{name}_{period}", block, months, out),
            **write_month_violins(
                violins_diurnal.sel(hour=int(monthly.attrs[f"{period}_hour_utc"])), f"{name}_{period}"
            ),
        }
        for period, block in stored.items()
        if period != "global"
    }
    return var


def to_download(ds: xr.Dataset, kind: str, title: str) -> tuple[xr.Dataset, dict]:
    """The statistics `ds` of step 4 as a NetCDF file for download, with CF attributes, and its encoding."""
    groups = ds["n"].dims
    out = ds[list(DOWNLOAD_VARIABLES)].transpose(*groups, "stat", "z", "lat", "lon", missing_dims="ignore")
    out["z"].attrs.update(standard_name="height", long_name="height above ground", units="m", positive="up")
    out["lat"].attrs.update(standard_name="latitude", units="degrees_north")
    out["lon"].attrs.update(standard_name="longitude", units="degrees_east")
    out["stat"].attrs.update(
        long_name="statistic over the time steps of a group",
        comment="pN: Nth percentile; iqr: p75 - p25. Of the time steps of the group: the mean of lcn2 is the log10 of "
        "the geometric mean of Cn2, the mean of cn2 the arithmetic mean",
    )
    out["month"].attrs.update(long_name="calendar month")
    if "hour" in out.dims:
        out["hour"].attrs.update(long_name="hour of the day", units="hours", comment="UTC")
    else:
        hours = ", ".join(f"{p}: {ds.attrs[f'{p}_hour_utc']:02d} UTC" for p in ds["period"].values if p != "global")
        out["period"].attrs.update(long_name="hours of the statistics", comment=f"global: all hours; {hours}")
    oqm = ", output quantile mapping nl-oQM" if ds.attrs.get("otprof_oqm") else ""
    out.attrs = {
        "title": f"OTProf climatology: {title.lower()}",
        "summary": "Statistics of Cn2 profiles, Fried parameter and scintillation index predicted by SQF-H from ERA5",
        "source": f"SQF-H ({ds.attrs.get('model')} at {ds.attrs.get('model_revision')}) on ERA5 0.25°, 3-hourly{oqm}",
        "sample_months": ds.attrs["months"],
        "disclaimer": DISCLAIMER,
        "license": LICENSE,
        "history": f"{pd.Timestamp.now(tz='UTC'):%Y-%m-%dT%H:%M:%SZ} otprof-live, climatology/step_5_convert_webui.py",
        "Conventions": "CF-1.8",
    }
    encoding = {}
    for name, rounding in DOWNLOAD_VARIABLES.items():
        chunks = [1 if d in groups else out.sizes[d] for d in out[name].dims]  # one group per chunk
        encoding[name] = {"zlib": True, "complevel": 4, "shuffle": True, "chunksizes": tuple(chunks), **rounding}
    return out, encoding


def write_downloads(sources: dict[str, xr.Dataset], out: pathlib.Path) -> list[dict]:
    """The NetCDF files for download of the statistics `sources` {kind: dataset}; returns their meta."""
    downloads = []
    for kind, ds in sources.items():
        file = f"otprof-clim_{kind}_EXPERIMENTAL.nc"
        nc, encoding = to_download(ds, kind, DOWNLOADS[kind])
        to_netcdf_atomic(nc, out / file, encoding=encoding, engine="netcdf4")
        downloads.append({"label": DOWNLOADS[kind], "file": file, "bytes": (out / file).stat().st_size})
    return downloads


def write_climatology(
    monthly: xr.Dataset,
    diurnal: xr.Dataset,
    violins_diurnal: xr.Dataset,
    violins_month: xr.Dataset,
    out: pathlib.Path,
) -> dict:
    """The climatology from the files of step 4 of the climatology pipeline → `out`; returns meta.json."""
    part = out.with_name(out.name + ".part")
    if part.exists():
        shutil.rmtree(part)
    part.mkdir(parents=True)

    variables = {n: write_variable(n, monthly, diurnal, violins_diurnal, violins_month, part) for n in CLIM_VARIABLES}
    months = monthly.attrs["months"].split()  # "YYYY-MM" of the sample
    meta = {
        "format": CLIM_FORMAT,
        "months": [int(m) for m in monthly["month"].values],
        "hours": [int(h) for h in diurnal["hour"].values],
        "years": [sorted({int(s[:4]) for s in months if int(s[5:]) == m}) for m in monthly["month"].values],
        "stats": [*CLIM_STATS, "lmean"],
        "periods": {
            str(p): {"utc_hour": int(monthly.attrs[f"{p}_hour_utc"])} for p in monthly["period"].values if p != "global"
        },
        "lat": [round(float(v), 5) for v in monthly["lat"].values],
        "lon": [round(float(v), 5) for v in monthly["lon"].values],
        "z_agl": [round(float(v), 2) for v in monthly["z"].values],
        "info": {
            "Model": "SQF-H",
            "Inputs": "ERA5 0.25°, 3-hourly",
            **({"Correction": "nl-oQM"} if monthly.attrs.get("otprof_oqm") else {}),
            "Sample": f"{len(months)} months, {min(months)} to {max(months)}",
        },
        "downloads": write_downloads({"monthly": monthly, "diurnal": diurnal}, part),
        "variables": variables,
    }
    (part / "meta.json").write_text(json.dumps(meta, indent=1))  # last: a directory with meta.json is complete

    old = out.with_name(out.name + ".old.part")
    if out.exists():
        out.rename(old)
    part.rename(out)
    if old.exists():
        shutil.rmtree(old)
    return meta
