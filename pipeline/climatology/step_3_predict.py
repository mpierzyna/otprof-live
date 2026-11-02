#!/usr/bin/env python3
"""Predict Cn2 profiles with the published SQF-H from the ERA5 of step 2 → `3_predictions/predictions.zarr`.

Month by month, in the order of step 2, every month in the ERA5 store (`list_months_in_store`) not predicted yet, so
this can run any time during the download, after step 2. Per month: `era5_cds.standardize` → `make_inputs` (binary
land-sea mask, as in training) → `otprof.predict.predict` with the output quantile
mapping, at the 99 default heights of the model (the WRF levels it was trained on, `z_agl`).

The store has the time axis of step 2 (months not predicted yet are NaN), dims (time, lat, lon[, bottom_top]):
`lcn2` (log10 Cn2 [m-2/3]) per height, `r0` (Fried parameter [cm]) and `lsi2` (log10 scintillation index, plane
wave) per profile, both 1550 nm, integrated over the 99 heights. The WRF turbulence quantities of the model (`QKE`,
`TSQ`, `EL_PBL`) are not kept. Chunks: 31 days x 5 latitudes x all longitudes x 11 heights, for the latitude bands
and height blocks of step 4. The months predicted are listed in `3_predictions/predictions.zarr.done`
(`list_months_predicted`, `open_predictions`).
"""

import argparse

import numpy as np
import xarray as xr
from otprof.models import sqf_h
from otprof.models.sqf_h import inputs
from otprof.predict import load_model, predict
from otprof.sources import era5_cds
from shared import CLIM_DATA
from step_2_to_zarr import TIMES, list_months_in_store, open_store
from tqdm import tqdm

STORE = CLIM_DATA / "3_predictions" / "predictions.zarr"
DONE_FILE = STORE.with_name(STORE.name + ".done")
CHUNKS = {"time": 248, "lat": 5, "lon": -1, "bottom_top": 11}
VARS = ["lcn2", "r0", "lsi2"]


def list_months_predicted() -> list[str]:
    """The months written to the store, in the order of step 2."""
    return DONE_FILE.read_text().split() if DONE_FILE.exists() else []


def open_predictions() -> xr.Dataset:
    """The store, only the time steps of the months predicted so far."""
    ds = xr.open_zarr(STORE)
    return ds.sel(time=ds["time"].dt.strftime("%Y-%m").isin(list_months_predicted()))


def make_inputs(ds: xr.Dataset) -> xr.Dataset:
    """SQF-H inputs of `ds` with a binary land-sea mask (`lsm` > 0.5): SQF-H is trained on WRF's binary mask, ERA5's
    `lsm` is the fractional land cover."""
    lsm = ds["lsm"]
    return inputs.make_inputs(ds.assign(lsm=(lsm > 0.5).astype(lsm.dtype).assign_attrs(lsm.attrs)))


def predict_month(predictor, month: str, device: str, batch_size: int) -> xr.Dataset:
    """`VARS` of `month`, float32, with the query heights as coordinate `z_agl` (bottom_top)."""
    era5 = open_store()
    ds = era5_cds.standardize(era5.sel(time=era5["time"].dt.strftime("%Y-%m") == month).load())
    y = predict(predictor, make_inputs(ds), device=device, batch_size=batch_size)
    z_agl = y["z_agl"].isel(time=0, lat=0, lon=0, drop=True)
    assert (y["z_agl"] == z_agl).all(), "query heights differ between profiles"
    out = y[VARS].astype(np.float32).assign_coords(z_agl=z_agl)
    return out.assign_attrs(y.attrs)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default=None, help="torch device (default: cuda if available, else cpu)")
    parser.add_argument("--batch-size", type=int, default=8192, help="profiles per batch (8192: ~8 GB on the GPU)")
    args = parser.parse_args()

    done = set(list_months_predicted())
    in_store = list_months_in_store()
    todo = [m for m in in_store if m not in done]
    print(f"{len(done)} months predicted, {len(todo)} to predict ({len(in_store)} in the ERA5 store of step 2)")
    if not todo:
        raise SystemExit(0)

    predictor = load_model(sqf_h.HF_REPO_ID, revision=sqf_h.HF_REVISION)
    for month in tqdm(todo, unit="month", dynamic_ncols=True):
        ds = predict_month(predictor, month, args.device, args.batch_size)
        if not STORE.exists():
            template = ds.isel(time=0, drop=True).chunk().expand_dims(time=TIMES).chunk(CHUNKS)
            template = template.assign_coords(z_agl=ds["z_agl"].load())  # in memory: written with the metadata
            template = template.assign_attrs(model=sqf_h.HF_REPO_ID, model_revision=sqf_h.HF_REVISION, **ds.attrs)
            template.to_zarr(STORE, compute=False)  # metadata and coordinates only
            DONE_FILE.write_text("")
        i = TIMES.get_loc(ds["time"].values[0])
        # months do not start on chunk boundaries: zarr updates the chunks they share, one month after the other
        ds.drop_vars([c for c in ds.coords if "time" not in ds[c].dims]).to_zarr(
            STORE, region={"time": slice(i, i + ds.sizes["time"])}, safe_chunks=False
        )
        with DONE_FILE.open("a") as f:
            f.write(month + "\n")
        done.add(month)
    print(f"{len(done)} months in {STORE}")
