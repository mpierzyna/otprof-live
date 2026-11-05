"""Step 3: convert the run's predictions (`2_prediction/preds.nc`) to the web app's data format `otprof-live/1`
(docs/DATA_FORMAT.md) → `WEBUI_DATA/<YYYYMMDDHH>/`, update `WEBUI_DATA/index.json`, and finish the run.

The cycle directory also gets the forecast as NetCDF for download (`otprof-live_<YYYYMMDDHH>_EXPERIMENTAL.nc`,
`to_download`, licence `LICENSE`): lcn2, r0 and lsi2 only (not the model's intermediate outputs), float32, compressed,
~7 MB instead of the 115 MB of `preds.nc`.

Only the newest `KEEP_CYCLES` cycles stay in the web app (older cycle directories are deleted; the index keeps the
climatology). Finishing the run removes the `running` link, so the next step 0 starts a new cycle, and deletes all but
the newest `KEEP_RUNS` run directories. Step 4 then uploads `WEBUI_DATA`; a failed upload does not block the next run.
"""

import datetime
import shutil

import numpy as np
import pandas as pd
import xarray as xr
from otprof.models import sqf_h
from shared import (
    CYCLE_FORMAT,
    FORECAST_DATA,
    KEEP_RUNS,
    RUNNING_DIR,
    WEBUI_DATA,
    logger,
    to_netcdf_atomic,
)

from otprof_live.config import setup_logging
from otprof_live.netcdf import LICENSE
from otprof_live.webui import write_cycle, write_index

VARIABLES = ["lcn2", "r0", "lsi2"]  # exported, in this order (the app shows them in this order)
KEEP_CYCLES = 8  # cycles kept in the web app (2 days of 6-hourly cycles)
INFO = {"Model": "SQF-H", "Inputs": "GFS 0.25°", "Correction": "nl-oQM"}
DISCLAIMER = (
    "Experimental research data from a machine-learning model (SQF-H) trained on WRF simulations over the Netherlands, "
    "driven by GFS forecasts, which differ from the training inputs. Not validated for operational use. Provided as "
    "is, without any warranty. Do not base safety-critical or operational decisions on it."
)


def to_grid(preds: xr.Dataset) -> tuple[xr.Dataset, pd.Timestamp]:
    """The predictions (time, lat, lon, bottom_top) as the writer's grid (lead, z, lat, lon) with increasing lat, lon
    and z, and the cycle (initialisation time)."""
    cycles = np.unique(preds["cycle"].values)
    if len(cycles) != 1:
        raise ValueError(f"Predictions of more than one cycle: {cycles}")
    z = preds["z_agl"].values.reshape(-1, preds.sizes["bottom_top"])
    if not np.allclose(z, z[0]):
        raise ValueError("Query heights differ between columns; the data format needs one set of heights")

    ds = (
        preds[VARIABLES]
        .swap_dims(time="lead")
        .drop_vars(["time", "cycle"])
        .assign_coords(bottom_top=z[0])
        .rename(bottom_top="z")
        .sortby(["lead", "z", "lat", "lon"])
    )
    ds["lcn2"].attrs.update(long_name="log10 Cn2", units="log10(m^-2/3)")
    return ds, pd.Timestamp(cycles[0])


def to_download(ds: xr.Dataset, cycle: pd.Timestamp, oqm: bool) -> tuple[xr.Dataset, dict]:
    """The forecast `ds` (of `to_grid`) as the NetCDF file for download, with CF attributes, and its encoding:
    dims (time, z, lat, lon) with the valid time; lcn2 rounded to 0.001 (netCDF4 `least_significant_digit`, far below
    the model's error: ~2 x smaller)."""
    lead = pd.to_timedelta(ds["lead"].values, unit="h")
    out = (
        ds.assign_coords(time=("lead", cycle + lead), lead=("lead", lead))
        .swap_dims(lead="time")
        .assign_coords(forecast_reference_time=cycle)
        .transpose("time", "z", "lat", "lon")
        .astype("float32")
    )
    out["time"].attrs.update(standard_name="time", long_name="valid time")
    out["lead"].attrs.update(standard_name="forecast_period", long_name="lead time")
    out["forecast_reference_time"].attrs.update(standard_name="forecast_reference_time", long_name="GFS cycle")
    out["z"].attrs.update(standard_name="height", long_name="height above ground", units="m", positive="up")
    out["lat"].attrs.update(standard_name="latitude", units="degrees_north")
    out["lon"].attrs.update(standard_name="longitude", units="degrees_east")
    out["lcn2"].attrs.update(long_name="log10 of the refractive index structure parameter Cn2 (1550 nm)")
    out["r0"].attrs.update(long_name="Fried parameter (1550 nm, vertical path from the ground through the column)")
    out["lsi2"].attrs.update(
        long_name="log10 scintillation index (1550 nm, plane wave, vertical path from the ground through the column)"
    )
    out.attrs = {
        "title": "OTProf live: optical turbulence forecast",
        "summary": "Cn2 profiles, Fried parameter and scintillation index predicted by SQF-H from a GFS forecast",
        "source": f"SQF-H ({sqf_h.HF_REPO_ID} at {sqf_h.HF_REVISION}) on GFS 0.25° cycle {cycle:%Y-%m-%d %H} UTC"
        + (", output quantile mapping nl-oQM" if oqm else ""),
        "disclaimer": DISCLAIMER,
        "license": LICENSE,
        "history": f"{pd.Timestamp.now(tz='UTC'):%Y-%m-%dT%H:%M:%SZ} otprof-live, live/step_3_convert.py",
        "Conventions": "CF-1.8",
    }
    chunks = (1, out.sizes["z"], out.sizes["lat"], out.sizes["lon"])  # one lead time per chunk
    encoding = {v: {"zlib": True, "complevel": 4, "shuffle": True, "chunksizes": chunks} for v in ["lcn2"]}
    encoding |= {v: {"zlib": True, "complevel": 4, "shuffle": True} for v in ["r0", "lsi2"]}
    encoding["lcn2"]["least_significant_digit"] = 3
    encoding["lead"] = {"units": "hours", "dtype": "int32"}
    return out, encoding


def is_run_dir(name: str) -> bool:
    """Whether `name` is the name of a run directory (a cycle in `CYCLE_FORMAT`)."""
    try:
        datetime.datetime.strptime(name, CYCLE_FORMAT)
        return True
    except ValueError:
        return False


def finish_run():
    """Remove the `running` link and all but the newest `KEEP_RUNS` run directories."""
    RUNNING_DIR.unlink()
    runs = sorted(d for d in FORECAST_DATA.iterdir() if d.is_dir() and not d.is_symlink() and is_run_dir(d.name))
    for old in runs[:-KEEP_RUNS]:
        logger.info(f"Deleting old run directory {old}")
        shutil.rmtree(old)


if __name__ == "__main__":
    setup_logging()

    preds = xr.open_dataset(RUNNING_DIR / "2_prediction" / "preds.nc").load()
    ds, cycle = to_grid(preds)
    info = INFO if preds.attrs.get("otprof_oqm") else {k: v for k, v in INFO.items() if k != "Correction"}

    cycle_id = f"{cycle:%Y%m%d%H}"
    nc, encoding = to_download(ds, cycle, oqm="Correction" in info)
    download = f"otprof-live_{cycle_id}_EXPERIMENTAL.nc"
    (WEBUI_DATA / cycle_id).mkdir(parents=True, exist_ok=True)
    to_netcdf_atomic(nc, WEBUI_DATA / cycle_id / download, encoding=encoding, engine="netcdf4")
    cycle_dir = write_cycle(ds, WEBUI_DATA, cycle_id, cycle, info=info, download=download)
    size = sum(f.stat().st_size for f in cycle_dir.iterdir()) / 1e6
    logger.info(f"Wrote {cycle_dir} ({size:.1f} MB, {ds.sizes['lead']} leads, {ds.sizes['z']} heights)")

    cycles = write_index(WEBUI_DATA, keep=KEEP_CYCLES)
    logger.info(f"Wrote index with cycles {cycles}")

    finish_run()
    logger.info(f"Run of cycle {cycle} finished")
