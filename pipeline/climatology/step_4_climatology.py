#!/usr/bin/env python3
"""Statistics of the predicted Cn2 profiles, Fried parameter and scintillation index of step 3 → `STATS_DIR`.

Variables: `lcn2` (log10 Cn2 [m-2/3], per height `z`), `cn2` (linear Cn2), `r0` (Fried parameter [cm]), `si2`
(scintillation index, plane wave) and `lsi2` (log10 `si2`), r0 and si2 at 1550 nm. The statistics of a log10 variable
and of its linear values are each computed from the samples: the percentiles agree (10^p(log10 x) = p(x), up to the
interpolation between neighbouring samples), the moments differ (the `mean` of `lcn2` is the log10 of the geometric
mean).

Files, with lat, lon and z increasing:

- `monthly.nc`: per calendar month and period, dims (period, month, stat, lat, lon[, z]), `STATS`. `period`: `global`
  (all hours), `day` and `night` (the hours `PERIOD_HOURS_UTC`, attributes `<period>_hour_utc`). `n` (period, month):
  the time steps. The extreme percentiles rest on few time steps (p0.01 / p99.99: 1 in 10 000; a calendar month of 22
  years has ~5 500 time steps, a day or night ~680).
- `diurnal.nc`: per calendar month and hour [UTC], dims (month, hour, stat, lat, lon[, z]), `BOX_STATS` (box plots: box
  p25 .. p75, whiskers p5 .. p95). `n` (month, hour): the time steps.
- `violins_diurnal.nc`: the distributions of `VIOLIN_VARS` per calendar month and hour, for violin plots: histograms in
  bins over the range of the variable in all data (centres `<var>_x`; si2: up to its 99.9th percentile, the far tail
  left out), smoothed with a Gaussian of Silverman's bandwidth (a binned kernel density estimate), cut to the range of
  the samples, scaled to a maximum of 1 per violin (NaN without data); dims (month, hour, <var>_x, lat, lon).
- `violins_month.nc`: the same per calendar month (all hours), in the same bins; dims (month, <var>_x, lat, lon).

Uses the months predicted so far (attributes `months`, `n_months`): during the download a sample of the years spread by
the Sobol order of step 1, so early climatologies have few years per calendar month. Memory: one latitude band of the
store (5 of 25 latitudes, ~3.6 GB of lcn2 for all 22 years) at a time.
"""

import numpy as np
import pandas as pd
import xarray as xr
from shared import (
    PERIOD_HOURS_UTC,
    PREDICTION_CHUNKS,
    PREDICTIONS_STORE,
    STATS_DIR,
    list_months_done,
    open_done,
    to_grid,
)
from tqdm import tqdm

from otprof_live.netcdf import to_netcdf_atomic

PERCENTILES = (0.01, 0.05, 0.1, 0.5, 2.5, 5.0, 25.0, 50.0, 75.0, 95.0, 97.5, 99.5, 99.9, 99.95, 99.99)
BOX_PERCENTILES = (5.0, 25.0, 50.0, 75.0, 95.0)
STATS = ["mean", "std", "min", *(f"p{p:g}" if p != 50 else "median" for p in PERCENTILES), "max", "iqr"]
BOX_STATS = ["mean", *(f"p{p:g}" if p != 50 else "median" for p in BOX_PERCENTILES), "iqr"]
# Variables of the violin plots: histogram bins of their densities and the upper end of the bins as a percentile of all
# data (100: the maximum). Linear si2 is skewed: finer bins, and its far tail left out.
VIOLIN_VARS = {"r0": (100, 100.0), "lsi2": (100, 100.0), "si2": (400, 99.9)}
ATTRS = {
    "lcn2": {"long_name": "log10 of the refractive index structure parameter Cn2", "units": "log10(m-2/3)"},
    "cn2": {"long_name": "refractive index structure parameter Cn2", "units": "m-2/3"},
    "r0": {"long_name": "Fried parameter, 1550 nm", "units": "cm"},
    "si2": {"long_name": "scintillation index, plane wave, 1550 nm", "units": "1"},
    "lsi2": {"long_name": "log10 of the scintillation index, plane wave, 1550 nm", "units": "1"},
    "n": {"long_name": "number of time steps", "units": "1"},
}


def make_masks(times: pd.DatetimeIndex) -> tuple[xr.DataArray, xr.DataArray]:
    """The time steps of each group of `monthly.nc` (period, month, time) and of `diurnal.nc` (month, hour, time)."""
    months, hours = list(range(1, 13)), sorted(set(times.hour))
    missing = set(PERIOD_HOURS_UTC.values()) - set(hours)
    assert not missing, f"The data have no time steps at {missing} UTC (`PERIOD_HOURS_UTC`), only at {hours}"
    in_month = np.array([times.month == m for m in months])
    in_period = np.array([np.ones(len(times), dtype=bool), *(times.hour == h for h in PERIOD_HOURS_UTC.values())])
    in_hour = np.array([times.hour == h for h in hours])
    monthly = xr.DataArray(
        in_period[:, None] & in_month[None],
        dims=("period", "month", "time"),
        coords={"period": ["global", *PERIOD_HOURS_UTC], "month": months},
    )
    diurnal = xr.DataArray(
        in_month[:, None] & in_hour[None], dims=("month", "hour", "time"), coords={"month": months, "hour": hours}
    )
    return monthly, diurnal


def compute_stats(a: np.ndarray, box: bool = False) -> np.ndarray:
    """`STATS` (`box`: `BOX_STATS`) over the first axis of `a` (no NaNs), stacked on a new first axis; NaN if `a` is
    empty (a group without predicted months yet)."""
    percentiles, names = (BOX_PERCENTILES, BOX_STATS) if box else (PERCENTILES, STATS)
    if not len(a):
        return np.full((len(names), *a.shape[1:]), np.nan, dtype=np.float32)
    q = np.percentile(a, percentiles, axis=0)
    iqr = q[percentiles.index(75.0)] - q[percentiles.index(25.0)]
    mean = a.mean(axis=0, dtype=np.float64)
    if box:
        return np.stack([mean, *q, iqr]).astype(np.float32)
    return np.stack([mean, a.std(axis=0, dtype=np.float64), a.min(axis=0), *q, a.max(axis=0), iqr]).astype(np.float32)


def compute_density(a: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Smoothed histogram of each column of `a` (samples, columns) on the uniform bin centres `x`: the counts per bin,
    smoothed with a Gaussian of Silverman's bandwidth per column (a binned kernel density estimate), cut to the range of
    the column (no density where nothing was observed, e.g. r0 < 0), scaled to a maximum of 1 per column:
    (len(x), columns). Samples beyond the bins are left out (the bandwidth still uses all). NaN if `a` is empty."""
    n, n_cols = a.shape
    if not n:
        return np.full((len(x), n_cols), np.nan, dtype=np.float32)
    dx = x[1] - x[0]
    inside = (a >= x[0] - dx / 2) & (a <= x[-1] + dx / 2)
    bins = np.clip(np.round((a - x[0]) / dx).astype(int), 0, len(x) - 1)
    hist = np.bincount(
        (bins * n_cols + np.arange(n_cols)).ravel(), weights=inside.ravel(), minlength=len(x) * n_cols
    ).reshape(len(x), n_cols)
    q25, q75 = np.percentile(a, [25, 75], axis=0)
    spread = np.minimum(a.std(axis=0), (q75 - q25) / 1.34)
    spread = np.where(spread > 0, spread, a.std(axis=0))  # IQR 0: the std
    bw = np.maximum(0.9 * spread * n ** -0.2, dx)  # at least one bin (also for constant columns)
    kernel = np.exp(-0.5 * ((x[:, None, None] - x[None, :, None]) / bw.astype(np.float32)) ** 2)  # (x, bin, column)
    density = np.einsum("ijc,jc->ic", kernel, hist)
    k = np.arange(len(x))[:, None]
    density[(k < np.where(inside, bins, len(x)).min(axis=0)) | (k > np.where(inside, bins, -1).max(axis=0))] = 0
    peak = density.max(axis=0)
    return (density / np.where(peak > 0, peak, np.nan)).astype(np.float32)


def group_stats(values: xr.Dataset, masks: xr.DataArray, box: bool = False) -> xr.Dataset:
    """The statistics of each variable of `values` (time first) over the time steps of each group of `masks`
    (..., time): dims (<groups>, stat, ...)."""
    groups = masks.dims[:-1]
    flat = masks.values.reshape(-1, masks.sizes["time"])
    out = xr.Dataset(coords={**{g: masks[g] for g in groups}, "stat": BOX_STATS if box else STATS})
    for name, da in values.data_vars.items():
        stats = np.stack([compute_stats(da.values[m], box) for m in flat])
        out[name] = ((*groups, "stat", *da.dims[1:]), stats.reshape(*masks.shape[:-1], *stats.shape[1:]))
    return out.assign_coords({c: values[c] for c in values.dims if c != "time"})


def compute_statistics(ds: xr.Dataset, monthly_masks: xr.DataArray, diurnal_masks: xr.DataArray):
    """`monthly.nc` and `diurnal.nc` of `ds`, one latitude band of the store chunks after the other."""
    monthly, diurnal = [], []
    step = PREDICTION_CHUNKS["lat"]
    for i in tqdm(range(0, ds.sizes["lat"], step), desc="statistics", unit="band", dynamic_ncols=True):
        band = ds.isel(lat=slice(i, i + step)).transpose("time", "lat", "lon", "z").load()
        assert all(np.isfinite(band[v].values).all() for v in band.data_vars), "NaN or inf in the predictions"
        values = band.assign(cn2=10.0 ** band["lcn2"], si2=10.0 ** band["lsi2"])
        monthly.append(group_stats(values, monthly_masks))
        diurnal.append(group_stats(values, diurnal_masks, box=True))
        del band, values
    results = []
    for parts, masks in ((monthly, monthly_masks), (diurnal, diurnal_masks)):
        out = xr.concat(parts, "lat", coords="minimal", compat="override")
        out["n"] = masks.sum("time").astype("int32")
        results.append(out.assign({v: out[v].assign_attrs(ATTRS[v]) for v in out.data_vars}))
    return results


def compute_violins(ds: xr.Dataset, monthly_masks: xr.DataArray, diurnal_masks: xr.DataArray):
    """`violins_diurnal.nc` and `violins_month.nc` of `ds`."""
    columns = ds[["r0", "lsi2"]].transpose("time", "lat", "lon").load()
    columns["si2"] = 10.0 ** columns["lsi2"]
    n_lat, n_lon = ds.sizes["lat"], ds.sizes["lon"]
    grid = {c: ds[c] for c in ("lat", "lon")}
    by_hour = xr.Dataset(coords={"month": diurnal_masks["month"], "hour": diurnal_masks["hour"], **grid})
    by_month = xr.Dataset(coords={"month": diurnal_masks["month"], **grid})
    in_month = monthly_masks.sel(period="global").values
    for v, (n_bins, top) in tqdm(VIOLIN_VARS.items(), desc="violins", unit="var", dynamic_ncols=True):
        a = columns[v].values.reshape(ds.sizes["time"], n_lat * n_lon)
        x = np.linspace(a.min(), np.percentile(a, top), n_bins)  # bin centres
        by_hour = by_hour.assign_coords({f"{v}_x": (f"{v}_x", x, ATTRS[v])})
        by_hour[v] = (
            ("month", "hour", f"{v}_x", "lat", "lon"),
            np.array([[compute_density(a[m], x).reshape(-1, n_lat, n_lon) for m in ms] for ms in diurnal_masks.values]),
            ATTRS[v],
        )
        by_month = by_month.assign_coords({f"{v}_x": (f"{v}_x", x, ATTRS[v])})
        by_month[v] = (
            ("month", f"{v}_x", "lat", "lon"),
            np.array([compute_density(a[m], x).reshape(-1, n_lat, n_lon) for m in in_month]),
            ATTRS[v],
        )
    return by_hour, by_month


if __name__ == "__main__":
    months = list_months_done(PREDICTIONS_STORE)
    if not months:
        raise SystemExit("No predictions yet: run step 3 first.")
    ds = to_grid(open_done(PREDICTIONS_STORE))
    times = pd.DatetimeIndex(ds["time"].values)
    print(f"{len(months)} months, {len(times)} time steps, {ds.sizes['lat']} x {ds.sizes['lon']} grid points")
    monthly_masks, diurnal_masks = make_masks(times)
    monthly, diurnal = compute_statistics(ds, monthly_masks, diurnal_masks)
    violins_diurnal, violins_month = compute_violins(ds, monthly_masks, diurnal_masks)

    attrs = {"months": " ".join(sorted(months)), "n_months": len(months), **ds.attrs}
    monthly = monthly.assign_attrs({f"{p}_hour_utc": h for p, h in PERIOD_HOURS_UTC.items()})
    STATS_DIR.mkdir(exist_ok=True)
    for name, out in (
        ("monthly", monthly),
        ("diurnal", diurnal),
        ("violins_diurnal", violins_diurnal),
        ("violins_month", violins_month),
    ):
        compress = {v: {"zlib": True, "complevel": 4} for v in out.data_vars}
        to_netcdf_atomic(out.assign_attrs(attrs), STATS_DIR / f"{name}.nc", encoding=compress, engine="netcdf4")
    print(f"Wrote {', '.join(sorted(p.name for p in STATS_DIR.glob('*.nc')))} to {STATS_DIR}")
