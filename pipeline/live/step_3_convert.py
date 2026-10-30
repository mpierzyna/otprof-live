"""Step 3: convert the run's predictions (`2_prediction/preds.nc`) to the web app's data format `otprof-live/1`
(docs/DATA_FORMAT.md) → `WEBUI_DATA/<YYYYMMDDHH>/`, update `WEBUI_DATA/index.json`, and finish the run.

Only the newest `KEEP_CYCLES` cycles stay in the web app (older cycle directories are deleted; the index keeps the
climatology). Finishing the run removes the `running` link, so the next step 0 starts a new cycle, and deletes all but
the newest `KEEP_RUNS` run directories. Step 4 then uploads `WEBUI_DATA`; a failed upload does not block the next run.
"""

import datetime
import shutil

import numpy as np
import pandas as pd
import xarray as xr
from shared import (
    CYCLE_FORMAT,
    FORECAST_DATA,
    KEEP_RUNS,
    RUNNING_DIR,
    WEBUI_DATA,
    logger,
)

from otprof_live.config import setup_logging
from otprof_live.webui import write_cycle, write_index

VARIABLES = ["lcn2", "r0", "lsi2"]  # exported, in this order (the app shows them in this order)
KEEP_CYCLES = 8  # cycles kept in the web app (2 days of 6-hourly cycles)
INFO = {"Model": "SQF-H", "Inputs": "GFS 0.25°", "Correction": "nl-oQM"}


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

    cycle_dir = write_cycle(ds, WEBUI_DATA, f"{cycle:%Y%m%d%H}", cycle, info=info)
    size = sum(f.stat().st_size for f in cycle_dir.iterdir()) / 1e6
    logger.info(f"Wrote {cycle_dir} ({size:.1f} MB, {ds.sizes['lead']} leads, {ds.sizes['z']} heights)")

    cycles = write_index(WEBUI_DATA, keep=KEEP_CYCLES)
    logger.info(f"Wrote index with cycles {cycles}")

    finish_run()
    logger.info(f"Run of cycle {cycle} finished")
