import datetime
import logging
import pathlib

import numpy as np
import xarray as xr
from otprof.sources import Area

logger = logging.getLogger("otprof-live")

HERE = pathlib.Path(__file__).parent
DATA_ROOT = HERE / "data"
RUNNING_DIR = DATA_ROOT / "running"
WEBUI_ROOT = HERE / "data_webui"  # data root of the web app (docs/DATA_FORMAT.md), mirrored to the remote by step 4

# One run per GFS cycle: the run directory is named after the cycle (DATA_ROOT / "20261029T06")
CYCLE_FORMAT = "%Y%m%dT%H"
LEADS = range(121)  # analysis and 1 to 120 hours, every hour (GFS is hourly up to 120 h)
EXIT_NOTHING_NEW = 99  # exit code of step 0 if the newest cycle is already processed (Airflow skips the other steps)

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


def get_running_cycle() -> datetime.datetime:
    """The GFS cycle of the running pipeline, from the name of its run directory (set by step 0)."""
    name = RUNNING_DIR.resolve().name
    try:
        return datetime.datetime.strptime(name, CYCLE_FORMAT)
    except ValueError:
        raise RuntimeError(f"{RUNNING_DIR} -> {name}: not a cycle run directory ({CYCLE_FORMAT})") from None
