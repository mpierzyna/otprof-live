import pathlib
import logging

import numpy as np
import xarray as xr

from otprof.sources import Area

logger = logging.getLogger("otprof-live")

HERE = pathlib.Path(__file__).parent
DATA_ROOT = HERE / "data"
RUNNING_DIR = DATA_ROOT / "running"
WEBUI_ROOT = HERE / "data_webui"  # data root of the web app (docs/DATA_FORMAT.md), mirrored to the remote by step 4

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
