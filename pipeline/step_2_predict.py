import logging

import xarray as xr
from otprof.models import sqf_h
from otprof.predict import load_model, predict
from otprof.sources import gfs

from shared import RUNNING_DIR, logger, to_netcdf

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    logger.info("Loading GFS data...")
    ds = xr.open_mfdataset(str(RUNNING_DIR / "1_raw" / "gfs_*.nc"), engine="h5netcdf")
    ds = gfs.standardize(ds)

    out_dir = RUNNING_DIR / "2_prediction"
    out_dir.mkdir(exist_ok=True)

    logger.info("Loading model...")
    predictor = load_model(sqf_h.HF_REPO_ID, revision=sqf_h.HF_REVISION)

    X = predictor.make_inputs(ds)
    y = predict(predictor, X)
    to_netcdf(y, out_dir / "preds.nc")
    logger.info("Predictions saved.")
