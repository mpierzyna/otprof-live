"""Settings of the live forecast pipeline. Paths: `otprof_live.config` (env vars, pipeline/.env)."""

import datetime

import numpy as np
import xarray as xr
from otprof.sources import Area

from otprof_live.config import FORECAST_DATA, WEBUI_DATA, logger  # noqa: F401 (used by the steps)

RUNNING_DIR = FORECAST_DATA / "running"  # link to the run directory of the cycle in progress (step 0 .. step 3)

# One run per GFS cycle: the run directory is named after the cycle (FORECAST_DATA / "20261029T06")
CYCLE_FORMAT = "%Y%m%dT%H"
LEADS = range(121)  # analysis and 1 to 120 hours, every hour (GFS is hourly up to 120 h)
EXIT_NOTHING_NEW = 99  # exit code of step 0 if the newest cycle is already processed (run.sh stops there)
KEEP_RUNS = 8  # run directories kept in FORECAST_DATA (~140 MB each), as many as cycles in the web app

AREA_NL = Area(
    lon_min=3.0,
    lon_max=8.0,
    lat_min=50.0,
    lat_max=54.5,
)


# Fixed encoding for all datetimes; otherwise xarray infers units per file (e.g. "days since" for single-lead
# files), which is then inherited by downstream steps and cannot represent their 3-hourly times.
TIME_ENCODING = {"units": "hours since 1970-01-01", "dtype": "int64"}


def to_netcdf(ds: xr.Dataset, path, **kwargs):
    """`ds.to_netcdf` with all datetime variables encoded with `TIME_ENCODING`."""
    encoding = {v: TIME_ENCODING for v in ds.variables if np.issubdtype(ds[v].dtype, np.datetime64)}
    return ds.to_netcdf(path, encoding=encoding, **kwargs)


def to_netcdf_atomic(ds: xr.Dataset, path, **kwargs):
    """`to_netcdf` to `<path>.part`, renamed to `path` when complete: an interrupted write leaves no file at `path`."""
    part = path.with_name(path.name + ".part")
    to_netcdf(ds, part, **kwargs)
    part.replace(path)


def get_running_cycle() -> datetime.datetime:
    """The GFS cycle of the running pipeline, from the name of its run directory (set by step 0)."""
    if not RUNNING_DIR.exists():
        raise RuntimeError(f"{RUNNING_DIR} missing: no run in progress (start one with step 0)")
    name = RUNNING_DIR.resolve().name
    try:
        return datetime.datetime.strptime(name, CYCLE_FORMAT)
    except ValueError:
        raise RuntimeError(f"{RUNNING_DIR} -> {name}: not a cycle run directory ({CYCLE_FORMAT})") from None
