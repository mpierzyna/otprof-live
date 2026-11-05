"""Settings and helpers of the climatology pipeline (steps 1 to 5). The steps import from here, not from each other.
Paths: `otprof_live.config` (env vars, pipeline/.env).

`CLIM_DATA` (`OTPROF_CLIM_DATA`, default pipeline/data/climatology) holds `1_raw/` (GRIB, ERA5 zarr), `3_predictions/`
and `4_climatology/`, ~250 GB in all. Step 5 writes the web app's climatology into `WEBUI_DATA`, the data root shared
with the forecast pipeline, which ../upload.sh publishes.
"""

import pathlib
from functools import cache

import pandas as pd
import xarray as xr
from otprof.sources import Area, era5_cds

from otprof_live.config import CLIM_DATA, WEBUI_DATA, logger  # noqa: F401 (used by the steps)

GRIB_DIR = CLIM_DATA / "1_raw" / "cds"
ERA5_STORE = CLIM_DATA / "1_raw" / "era5.zarr"
PREDICTIONS_STORE = CLIM_DATA / "3_predictions" / "predictions.zarr"
STATS_DIR = CLIM_DATA / "4_climatology"

AREA = Area(lon_min=2, lon_max=9, lat_min=49, lat_max=55)  # the NL training area of SQF-H
START, END = "2005-01", "2026-06"  # END: last month of final ERA5 (later months are the preliminary ERA5T)
HOURS = range(0, 24, 3)  # UTC
TIMES = pd.date_range(START, pd.Period(END, freq="M").end_time, freq=f"{HOURS.step}h")  # time axis of the stores
# Chunks of the predictions: 31 days x 5 latitudes x all longitudes x 11 heights, for the latitude bands of step 4
PREDICTION_CHUNKS = {"time": 248, "lat": 5, "lon": -1, "bottom_top": 11}

# Hours [UTC] of the day and night statistics. These suit the Netherlands; for other locations, align them with local
# noon and local midnight.
PERIOD_HOURS_UTC = {"day": 12, "night": 0}


def done_file(store: pathlib.Path) -> pathlib.Path:
    """The file listing the months written to a zarr store with the time axis `TIMES`."""
    return store.with_name(store.name + ".done")


def list_months_done(store: pathlib.Path) -> list[str]:
    """The months written to `store`, in the order written."""
    file = done_file(store)
    return file.read_text().split() if file.exists() else []


def open_done(store: pathlib.Path) -> xr.Dataset:
    """`store`, only the time steps of the months written so far (the others are NaN)."""
    ds = xr.open_zarr(store)
    return ds.sel(time=ds["time"].dt.strftime("%Y-%m").isin(list_months_done(store)))


def to_grid(ds: xr.Dataset) -> xr.Dataset:
    """Increasing lat and lon, heights as the coordinate `z`."""
    if "bottom_top" in ds.dims:
        ds = ds.assign_coords(bottom_top=ds["z_agl"].values).drop_vars("z_agl").rename(bottom_top="z")
    return ds.sortby(["lat", "lon"])


def order_quarters_sobol(start: str, end: str, *, seed: int = 0) -> list[str]:
    """The quarters of `start` .. `end` (e.g. "2005-01", "2026-06"; whole quarters) in the order of a scrambled 2D
    Sobol sequence over (year, quarter): every prefix of the list spreads evenly over the years and over the seasons.

    Points falling on a quarter out of range or already taken are skipped. Deterministic for a given `seed`.
    """
    from scipy.stats import qmc

    todo = {str(q) for q in pd.period_range(start, end, freq="Q")}
    years = sorted({int(q[:4]) for q in todo})
    sampler = qmc.Sobol(d=2, scramble=True, seed=seed)
    order: list[str] = []
    while todo:
        assert sampler.num_generated < 2**20, f"Sobol sequence did not reach {sorted(todo)}"
        for a, b in sampler.random(1024):  # powers of 2 keep the balance of the sequence
            quarter = f"{years[int(a * len(years))]}Q{int(b * 4) + 1}"
            if quarter in todo:
                todo.remove(quarter)
                order.append(quarter)
    return order


def list_months(quarter: str) -> list[str]:
    """The months of `quarter` (e.g. "2017Q1")."""
    first = pd.Period(quarter, "Q").asfreq("M", "start")
    return [str(m) for m in pd.period_range(first, first + 2)]


@cache
def download_quarters() -> list[str]:
    """The quarters in download order; fixed seed: the same order on every run."""
    return order_quarters_sobol(START, END, seed=0)


def download_months() -> list[str]:
    """The months in download order."""
    return [m for q in download_quarters() for m in list_months(q)]


def make_times(months: list[str], freq: str) -> pd.DatetimeIndex:
    """All times of `months` (e.g. ["2017-01"]) at `freq` (e.g. "3h")."""
    return pd.DatetimeIndex([t for m in months for t in pd.date_range(m, pd.Period(m, "M").end_time, freq=freq)])


def make_blocks() -> list[pd.DatetimeIndex]:
    """The time blocks in download order: the months of each quarter, 3-hourly."""
    return [make_times(list_months(q), f"{HOURS.step}h") for q in download_quarters()]


def make_blocks_to_download() -> list[pd.DatetimeIndex]:
    """`make_blocks` without the quarters whose months are all in the ERA5 store: their GRIB files are not needed any
    more, and may have been deleted (step 2)."""
    done = set(list_months_done(ERA5_STORE))
    return [make_times(list_months(q), f"{HOURS.step}h") for q in download_quarters() if not set(list_months(q)) <= done]


def make_era5_jobs() -> era5_cds.Jobs:
    """The CDS requests in download order: {file name in `GRIB_DIR`: job}, one block per quarter, e.g.
    `pl/2014_01-03_<i>.grib`."""
    return era5_cds.make_jobs(make_blocks(), AREA)
