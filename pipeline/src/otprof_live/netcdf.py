"""NetCDF files of both pipelines: atomic writing, fixed time encoding, the licence of the data for download."""

import numpy as np
import xarray as xr

LICENSE = "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)"  # of the data for download

# Fixed encoding for all datetimes; otherwise xarray infers units per file (e.g. "days since" for single-lead
# files), which is then inherited by downstream steps and cannot represent their 3-hourly times.
TIME_ENCODING = {"units": "hours since 1970-01-01", "dtype": "int64"}


def to_netcdf(ds: xr.Dataset, path, **kwargs):
    """`ds.to_netcdf` with all datetime variables encoded with `TIME_ENCODING` (and `encoding` given)."""
    encoding = {v: TIME_ENCODING for v in ds.variables if np.issubdtype(ds[v].dtype, np.datetime64)}
    return ds.to_netcdf(path, encoding=encoding | kwargs.pop("encoding", {}), **kwargs)


def to_netcdf_atomic(ds: xr.Dataset, path, **kwargs):
    """`to_netcdf` to `<path>.part`, renamed to `path` when complete: an interrupted write leaves no file at `path`."""
    part = path.with_name(path.name + ".part")
    to_netcdf(ds, part, **kwargs)
    part.replace(path)
