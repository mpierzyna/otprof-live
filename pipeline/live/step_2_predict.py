"""Step 2: predict Cn2 profiles, r0 and lsi2 with the published SQF-H from the run's GFS lead times (step 1) →
`2_prediction/preds.nc`.

Skipped if the predictions exist (written as `.part` and renamed when complete). Fails if lead times are missing.
"""

import xarray as xr
from otprof.models import sqf_h
from otprof.predict import load_model, predict
from otprof.sources import gfs
from shared import (
    CYCLE_FORMAT,
    LEADS,
    RUNNING_DIR,
    get_running_cycle,
    logger,
    to_netcdf_atomic,
)

from otprof_live.config import setup_logging

if __name__ == "__main__":
    setup_logging()

    out = RUNNING_DIR / "2_prediction" / "preds.nc"
    if out.exists():
        logger.info(f"{out} exists already; nothing to do.")
        raise SystemExit(0)

    cycle_str = get_running_cycle().strftime(CYCLE_FORMAT)
    files = sorted((RUNNING_DIR / "1_raw").glob(f"gfs_{cycle_str}+*.nc"))
    if len(files) != len(LEADS):
        raise RuntimeError(f"{len(files)} of {len(LEADS)} lead times downloaded: run step 1 first")
    logger.info(f"Loading GFS data for cycle {cycle_str}...")
    ds = gfs.standardize(xr.open_mfdataset(files, engine="h5netcdf"))

    logger.info("Loading model...")
    predictor = load_model(sqf_h.HF_REPO_ID, revision=sqf_h.HF_REVISION)

    y = predict(predictor, predictor.make_inputs(ds))
    out.parent.mkdir(exist_ok=True)
    to_netcdf_atomic(y, out)
    logger.info(f"Predictions saved to {out}.")
