#!/usr/bin/env python3
"""Climatology of the predicted Cn2 profiles, Fried parameter and scintillation index of step 3 → `4_climatology/`.

Variables: `lcn2` (log10 Cn2 [m-2/3], per height `z_agl`), `cn2` (linear Cn2, 10^`lcn2`), `r0` (Fried parameter [cm]),
`si2` (scintillation index, plane wave) and `lsi2` (log10 `si2`), r0 and si2 at 1550 nm: the statistics of the
log10 variables and of their linear values each computed from the samples. The percentiles agree (10^p(log10 x) =
p(x), up to the interpolation between neighbouring samples); the moments (mean, std) differ. Statistics (dim `stat`): `n` (number of time steps),
`mean`, `std`, `min`, the percentiles `p0.01`, `p0.05`, `p0.1`, `p0.5`, `p2.5`, `p5`, `p25`, `median`, `p75`, `p95`,
`p97.5`, `p99.5`, `p99.9`, `p99.95`, `p99.99` (the low end mirrors the high end), `max` and `iqr` (p75 - p25). Also
`lcn2_linear_mean`: log10 of the mean of the linear Cn2, the value integrated optical quantities depend on (the `mean`
of `lcn2` is the log10 of the geometric mean). The extreme percentiles rest on few time steps per grid point and group
(p0.01 / p99.99: 1 in 10 000; a calendar month of 22 years has ~5 500 time steps), better pooled over the domain.

Groupings of the time steps: `all`, `season` (DJF, MAM, JJA, SON), `month` (calendar month), `hour` (UTC), and
`month_day`, `month_night`: per calendar month the time steps nearest to 12 and 00 local time (`UTC_OFFSET`, no daylight
saving; with 3-hourly data 12 and 00 UTC, i.e. 13:00 and 01:00 local, see `period_hours`; attributes `local_hour`,
`utc_hour`, `utc_offset`, the dim is `month`). Files:

- `grid_<grouping>.nc`: per grid point, dims ([grouping,] stat, lat, lon[, bottom_top])
- `domain_<grouping>.nc`: pooled over all grid points and time steps, dims ([grouping,] stat[, bottom_top])
- `grid_month_hour.nc`: diurnal cycle of `r0`, `si2`, `lsi2` per grid point and calendar month, for box plots:
  dims (month, hour, stat, lat, lon), `stat`: `n`, `mean`, `p5`, `p25`, `median`, `p75`, `p95`, `iqr` (box p25 .. p75,
  whiskers p5 .. p95); the same of `lcn2` per height (dims (month, hour, stat, lat, lon, bottom_top)), with
  `lcn2_linear_mean` (month, hour, lat, lon, bottom_top)
- `grid_month_hour_violin.nc`: the same diurnal cycle of `r0`, `lsi2` and `si2` as distributions, for violin plots:
  histograms in the bins of `VIOLIN_VARS` (centres `<var>_x`) over the range of the variable in all data (si2: up to
  its 99.9th percentile, the far tail left out), smoothed with a Gaussian of
  Silverman's bandwidth per month, hour and grid point (a binned kernel density estimate) and cut to its range, scaled to a maximum of 1 per violin (NaN
  without data); dims (month, hour, <var>_x, lat, lon)
- `grid_month_violin.nc`: the same per calendar month (all hours), for violin plots of the annual cycle: dims (month,
  <var>_x, lat, lon)

Uses the months predicted so far (`list_months_predicted` of step 3; attributes `months`, `n_months`): during the
download a sample of the years spread by the Sobol order of step 1, so early climatologies have few years per calendar
month. Memory: one latitude band of the store (5 of 25 latitudes, ~3.6 GB of lcn2 for all 22 years) at a time.
"""

import numpy as np
import pandas as pd
import xarray as xr
from shared import CLIM_DATA
from step_3_predict import CHUNKS, list_months_predicted, open_predictions
from tqdm import tqdm

OUT = CLIM_DATA / "4_climatology"
PERCENTILES = (0.01, 0.05, 0.1, 0.5, 2.5, 5.0, 25.0, 50.0, 75.0, 95.0, 97.5, 99.5, 99.9, 99.95, 99.99)
BOX_PERCENTILES = (5.0, 25.0, 50.0, 75.0, 95.0)  # box plots of the diurnal cycle: box p25 .. p75, whiskers p5 .. p95
STATS = ["n", "mean", "std", "min", *(f"p{p:g}" if p != 50 else "median" for p in PERCENTILES), "max", "iqr"]
BOX_STATS = ["n", "mean", *(f"p{p:g}" if p != 50 else "median" for p in BOX_PERCENTILES), "iqr"]
SEASONS = ["DJF", "MAM", "JJA", "SON"]
# Local time follows the sun, not the clock: UTC+1 all year in the Netherlands, no daylight saving
UTC_OFFSET = 1
PERIOD_LOCAL_HOURS = {"day": 12, "night": 0}
# Variables of the violin plots of the diurnal cycle: histogram bins of their densities and the upper end of the bins
# as a percentile of all data (100: the maximum). Linear si2 is skewed: finer bins, and its far tail left out.
VIOLIN_VARS = {"r0": (100, 100.0), "lsi2": (100, 100.0), "si2": (400, 99.9)}
HEIGHT_VARS = ("lcn2", "cn2", "lcn2_linear_mean")  # variables per height (bottom_top)
ATTRS = {
    "lcn2": {"long_name": "log10 of the refractive index structure parameter Cn2", "units": "log10(m-2/3)"},
    "cn2": {"long_name": "refractive index structure parameter Cn2", "units": "m-2/3"},
    "r0": {"long_name": "Fried parameter, 1550 nm", "units": "cm"},
    "si2": {"long_name": "scintillation index, plane wave, 1550 nm", "units": "1"},
    "lsi2": {"long_name": "log10 of the scintillation index, plane wave, 1550 nm", "units": "1"},
    "lcn2_linear_mean": {"long_name": "log10 of the mean of the linear Cn2", "units": "log10(m-2/3)"},
}


def period_hours(hours: list[int]) -> dict[str, int]:
    """{period: the hour [UTC] of `hours` nearest to its local time `PERIOD_LOCAL_HOURS`} (the data may not have the
    exact one: 3-hourly data have neither 23 nor 11 UTC)."""

    def nearest(local: int) -> int:
        utc = (local - UTC_OFFSET) % 24
        return min(hours, key=lambda h: min((h - utc) % 24, (utc - h) % 24))

    return {p: nearest(local) for p, local in PERIOD_LOCAL_HOURS.items()}


def make_groups(times: pd.DatetimeIndex) -> dict[str, dict]:
    """{grouping: {group: boolean mask over `times`}}."""
    season = np.array(SEASONS)[(times.month.values % 12) // 3]
    hours = sorted(set(times.hour))
    return {
        "all": {"all": np.ones(len(times), dtype=bool)},
        "season": {s: season == s for s in SEASONS},
        "month": {m: np.asarray(times.month == m) for m in range(1, 13)},
        "hour": {h: np.asarray(times.hour == h) for h in hours},
        **{
            f"month_{p}": {m: np.asarray((times.month == m) & (times.hour == h)) for m in range(1, 13)}
            for p, h in period_hours(hours).items()
        },
    }


def compute_stats(a: np.ndarray, box: bool = False) -> np.ndarray:
    """`STATS` (`box`: `BOX_STATS`) over the first axis of `a` (no NaNs), stacked on a new first axis; NaN (`n` 0) if
    `a` is empty (a group without predicted months yet)."""
    percentiles, names = (BOX_PERCENTILES, BOX_STATS) if box else (PERCENTILES, STATS)
    if not len(a):
        empty = np.concatenate([np.zeros((1, *a.shape[1:])), np.full((len(names) - 1, *a.shape[1:]), np.nan)])
        return empty.astype(np.float32)
    q = np.percentile(a, percentiles, axis=0)
    iqr = q[percentiles.index(75.0)] - q[percentiles.index(25.0)]
    n, mean = np.full(a.shape[1:], len(a)), a.mean(axis=0, dtype=np.float64)
    if box:
        return np.stack([n, mean, *q, iqr]).astype(np.float32)
    return np.stack([n, mean, a.std(axis=0, dtype=np.float64), a.min(axis=0), *q, a.max(axis=0), iqr]).astype(
        np.float32
    )


def compute_stats_linear(a: np.ndarray) -> np.ndarray:
    """`compute_stats` of 10**`a` (Cn2 from lcn2)."""
    return compute_stats(10.0**a)


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


def compute_linear_mean(lcn2: np.ndarray) -> np.ndarray:
    """log10 of the mean of 10**`lcn2` over the first axis (NaN if empty)."""
    if not len(lcn2):
        return np.full(lcn2.shape[1:], np.nan, dtype=np.float32)
    return np.log10(np.mean(10.0 ** lcn2.astype(np.float64), axis=0)).astype(np.float32)


def compute_diurnal(lcn2: np.ndarray, times: pd.DatetimeIndex, hours: list[int]) -> tuple[np.ndarray, np.ndarray]:
    """Box statistics (`BOX_STATS`) and the linear mean (`compute_linear_mean`) of `lcn2` (time, ...) per calendar month
    and hour: (month, hour, stat, ...) and (month, hour, ...)."""
    stats = np.empty((12, len(hours), len(BOX_STATS), *lcn2.shape[1:]), dtype=np.float32)
    lmean = np.empty((12, len(hours), *lcn2.shape[1:]), dtype=np.float32)
    for i, m in enumerate(range(1, 13)):
        for j, h in enumerate(hours):
            a = lcn2[(times.month == m) & (times.hour == h)]
            stats[i, j] = compute_stats(a, box=True)
            lmean[i, j] = compute_linear_mean(a)
    return stats, lmean


def compute_all(values: dict[str, np.ndarray], groups: dict) -> dict[str, dict[str, np.ndarray]]:
    """{grouping: {variable: (group, [stat,] ...)}} of `values` (time first), with `lcn2_linear_mean`."""
    out = {}
    for g, masks in groups.items():
        out[g] = {v: np.stack([compute_stats(a[m]) for m in masks.values()]) for v, a in values.items()}
        if "lcn2" in values:
            out[g]["lcn2_linear_mean"] = np.stack([compute_linear_mean(values["lcn2"][m]) for m in masks.values()])
    return out


def to_dataset(arrays: dict[str, np.ndarray], grouping: str, groups: dict, coords: dict, dims: tuple) -> xr.Dataset:
    """{variable: (group, [stat,] ...)} → a dataset; `dims`: the dims after the statistics, for lcn2 (+ bottom_top).
    The group dim is dropped for `all`, and `month` for `month_day` and `month_night`."""
    ds = xr.Dataset()
    group_dim = "month" if grouping.startswith("month_") else grouping
    for name, a in arrays.items():
        has_height = name in HEIGHT_VARS
        names = (group_dim, *(() if name == "lcn2_linear_mean" else ("stat",)), *dims, *(("bottom_top",) * has_height))
        ds[name] = xr.DataArray(a, dims=names, attrs=ATTRS[name])
    ds = ds.assign_coords({group_dim: list(groups[grouping]), "stat": STATS, **coords})
    return ds.squeeze(grouping, drop=True) if grouping == "all" else ds


if __name__ == "__main__":
    months = list_months_predicted()
    if not months:
        raise SystemExit("No predictions yet: run step 3 first.")
    ds = open_predictions()
    times = pd.DatetimeIndex(ds["time"].values)
    groups = make_groups(times)
    hours = sorted(set(times.hour))
    n_lat, n_lon = ds.sizes["lat"], ds.sizes["lon"]
    print(f"{len(months)} months, {len(times)} time steps, {n_lat} x {n_lon} grid points")
    OUT.mkdir(exist_ok=True)

    # Per grid point: the latitude bands of the store chunks
    bands, bands_diurnal = [], []
    for i in tqdm(range(0, n_lat, CHUNKS["lat"]), desc="grid", unit="band", dynamic_ncols=True):
        band = ds.isel(lat=slice(i, i + CHUNKS["lat"])).transpose("time", "lat", "lon", "bottom_top").load()
        values = {v: band[v].values for v in ["lcn2", "r0", "lsi2"]}
        assert all(np.isfinite(a).all() for a in values.values()), "NaN or inf in the predictions"
        values["si2"] = 10.0 ** values["lsi2"]
        values["cn2"] = 10.0 ** values["lcn2"]
        bands.append(compute_all(values, groups))
        bands_diurnal.append(compute_diurnal(values["lcn2"], times, hours))
        del band, values
    # bands along lat: (group, [stat,] lat, lon[, bottom_top]), lat the axis -3 (lcn2) or -2 (per profile)
    grid = {
        g: {v: np.concatenate([b[g][v] for b in bands], axis=-3 if v in HEIGHT_VARS else -2) for v in bands[0][g]}
        for g in groups
    }

    # Pooled over the domain: all grid points as samples; lcn2 in the height blocks of the store chunks
    flat = ds[["r0", "lsi2"]].transpose("time", "lat", "lon").load()
    pooled = {v: flat[v].values.reshape(len(times), n_lat * n_lon) for v in ["r0", "lsi2"]}
    pooled["si2"] = 10.0 ** pooled["lsi2"]
    domain = {
        g: {v: np.stack([compute_stats(a[m].ravel()) for m in masks.values()]) for v, a in pooled.items()}
        for g, masks in groups.items()
    }
    blocks = []
    for k in tqdm(range(0, ds.sizes["bottom_top"], CHUNKS["bottom_top"]), desc="domain", unit="block"):
        lcn2 = ds["lcn2"].isel(bottom_top=slice(k, k + CHUNKS["bottom_top"])).transpose("time", "lat", "lon", ...)
        lcn2 = lcn2.values.reshape(len(times), n_lat * n_lon, -1)
        blocks.append(
            {
                g: [np.stack([f(lcn2[m].reshape(-1, lcn2.shape[-1])) for m in masks.values()]) for f in (compute_stats, compute_stats_linear, compute_linear_mean)]
                for g, masks in groups.items()
            }
        )  # fmt: skip
    for g in groups:
        for k, v in enumerate(["lcn2", "cn2", "lcn2_linear_mean"]):
            domain[g][v] = np.concatenate([b[g][k] for b in blocks], axis=-1)

    # Diurnal cycle per grid point and calendar month, for box plots (lcn2 per height: of the bands, lat the axis -3)
    diurnal = xr.Dataset(
        coords={"month": range(1, 13), "hour": hours, "stat": BOX_STATS, "lat": ds["lat"], "lon": ds["lon"]}
    ).assign_coords(z_agl=ds["z_agl"])
    for k, (v, dims) in enumerate(
        [("lcn2", ("month", "hour", "stat", "lat", "lon", "bottom_top")), ("lcn2_linear_mean", ("month", "hour", "lat", "lon", "bottom_top"))]
    ):  # fmt: skip
        a = np.concatenate([b[k] for b in bands_diurnal], axis=-3)
        diurnal[v] = xr.DataArray(a, dims=dims, attrs=ATTRS[v])
    del bands_diurnal
    for v, a in pooled.items():
        a = a.reshape(len(times), n_lat, n_lon)
        stats = [
            [compute_stats(a[(times.month == m) & (times.hour == h)], box=True) for h in hours] for m in range(1, 13)
        ]
        diurnal[v] = xr.DataArray(np.array(stats), dims=("month", "hour", "stat", "lat", "lon"), attrs=ATTRS[v])

    # The same as distributions, for violin plots; and per calendar month (all hours), in the same bins
    violin = xr.Dataset(coords={"month": range(1, 13), "hour": hours, "lat": ds["lat"], "lon": ds["lon"]})
    violin_month = xr.Dataset(coords={"month": range(1, 13), "lat": ds["lat"], "lon": ds["lon"]})
    for v, (n_bins, top) in tqdm(VIOLIN_VARS.items(), desc="violin", unit="var", dynamic_ncols=True):
        a = pooled[v]
        x = np.linspace(a.min(), np.percentile(a, top), n_bins)  # bin centres
        dens = [
            [compute_density(a[(times.month == m) & (times.hour == h)], x).reshape(-1, n_lat, n_lon) for h in hours]
            for m in range(1, 13)
        ]
        violin = violin.assign_coords({f"{v}_x": (f"{v}_x", x, ATTRS[v])})
        violin[v] = xr.DataArray(np.array(dens), dims=("month", "hour", f"{v}_x", "lat", "lon"), attrs=ATTRS[v])
        dens = [compute_density(a[times.month == m], x).reshape(-1, n_lat, n_lon) for m in range(1, 13)]
        violin_month = violin_month.assign_coords({f"{v}_x": (f"{v}_x", x, ATTRS[v])})
        violin_month[v] = xr.DataArray(np.array(dens), dims=("month", f"{v}_x", "lat", "lon"), attrs=ATTRS[v])

    attrs = {"months": " ".join(sorted(months)), "n_months": len(months), **ds.attrs}
    compress = {v: {"zlib": True, "complevel": 4} for v in ("lcn2", "lcn2_linear_mean")}
    diurnal.assign_attrs(attrs).to_netcdf(OUT / "grid_month_hour.nc", encoding=compress)
    violin.assign_attrs(attrs).to_netcdf(OUT / "grid_month_hour_violin.nc")
    violin_month.assign_attrs(attrs).to_netcdf(OUT / "grid_month_violin.nc")
    utc_hours = period_hours(hours)
    print("Day and night (UTC):", utc_hours, f"local time UTC+{UTC_OFFSET}")
    for g in groups:
        p = g.removeprefix("month_")
        group_attrs = {"local_hour": PERIOD_LOCAL_HOURS[p], "utc_hour": utc_hours[p], "utc_offset": UTC_OFFSET} if p in utc_hours else {}  # fmt: skip
        out = to_dataset(grid[g], g, groups, {"lat": ds["lat"], "lon": ds["lon"], "z_agl": ds["z_agl"]}, ("lat", "lon"))
        out.assign_attrs(attrs | group_attrs).to_netcdf(OUT / f"grid_{g}.nc")
        out = to_dataset(domain[g], g, groups, {"z_agl": ds["z_agl"]}, ())
        out.assign_attrs(attrs | group_attrs).to_netcdf(OUT / f"domain_{g}.nc")
    print(f"Wrote {', '.join(sorted(p.name for p in OUT.glob('*.nc')))} to {OUT}")
