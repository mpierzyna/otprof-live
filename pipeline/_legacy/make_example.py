"""Example cycles for developing the web app, from old predictions (not GFS): SQF-H predictions of the nl test set
(ERA5-driven, workspace 012_sqf_otprof), which come in blocks of 121 consecutive hours, i.e. like a 0-120 h forecast.

Per block: nl-oQM on lcn2, r0 and lsi2 from the corrected profile at the sample's WRF heights (as otprof.predict),
lcn2 interpolated to the mean WRF heights, the WRF-collocated ERA5 grid points snapped to the 0.25 deg grid (points
outside the WRF domain are missing).

Run from the repository root:  uv run --project ../otprof/code python pipeline/make_example.py
"""

from __future__ import annotations

import pathlib

import joblib
import numpy as np
import pandas as pd
import xarray as xr
from otprof import RUNS_ROOT
from otprof.pipelines.shared import Z_AGL_WRF
from research_tools.ot import ot

from write_cycle import write_cycle

## Settings
PRED_DIR = (
    pathlib.Path(__file__).parents[2]
    / "../workspaces/012_sqf_otprof/saved_models/preds_sqfh_nl"
)
OQM_FILE = RUNS_ROOT / "models" / "wrf_pl" / "oqm_lcn2.joblib"
CYCLES = [
    pd.Timestamp("2017-06-10 00:00"),
    pd.Timestamp("2017-10-28 00:00"),
]  # starts of test blocks
N_LEADS = 121
DATA_ROOT = (
    pathlib.Path(__file__).parents[1] / "dev-data"
)  # served at /data/ by the dev server
DLAT = DLON = 0.25

if __name__ == "__main__":
    y_pred = xr.open_dataset(PRED_DIR.resolve() / "era5pl_y_pred.nc")
    y_test = xr.open_dataset(PRED_DIR.resolve() / "era5pl_y_test.nc")
    qm = joblib.load(OQM_FILE)[0]
    for cycle in CYCLES:
        times = pd.date_range(cycle, periods=N_LEADS, freq="1h")
        sel = np.isin(y_pred["time"].values, times.values)
        pred = y_pred[["lcn2"]].isel(sample=sel).load()
        z = y_test["z_agl"].isel(sample=sel).rename(bottom_top="level").load()
        lcn2 = qm.transform(pred)["lcn2"]
        cn2 = 10**lcn2
        r0 = ot.fried_r0_xr(cn2=cn2, z=z, dim="level") * 100
        lsi2 = np.log10(ot.scint_index_xr(cn2=cn2, z=z, dim="level", mode="plane"))
        lcn2_z = np.stack(
            [np.interp(Z_AGL_WRF, zs, ls) for zs, ls in zip(z.values, lcn2.values)]
        )

        # Samples to the grid (lead, z, lat, lon)
        i_t = times.get_indexer(pred["time"].values)
        i_la = np.round((pred["lat"].values - 50.25) / DLAT).astype(int)
        i_lo = np.round((pred["lon"].values - 2.75) / DLON).astype(int)
        i_la, i_lo = i_la - i_la.min(), i_lo - i_lo.min()
        lat = 50.25 + DLAT * (
            np.arange(i_la.max() + 1)
            + np.round((pred["lat"].values.min() - 50.25) / DLAT)
        )
        lon = 2.75 + DLON * (
            np.arange(i_lo.max() + 1)
            + np.round((pred["lon"].values.min() - 2.75) / DLON)
        )
        grid = np.full(
            (N_LEADS, len(Z_AGL_WRF), len(lat), len(lon)), np.nan, dtype=np.float32
        )
        grid[i_t, :, i_la, i_lo] = lcn2_z
        col = {
            v: np.full((N_LEADS, len(lat), len(lon)), np.nan, dtype=np.float32)
            for v in ["r0", "lsi2"]
        }
        col["r0"][i_t, i_la, i_lo] = r0.values
        col["lsi2"][i_t, i_la, i_lo] = lsi2.values
        dims3 = ("lead", "lat", "lon")
        ds = xr.Dataset(
            {
                "lcn2": (("lead", "z", "lat", "lon"), grid, {"long_name": "log10 Cn2", "units": "log10(m^-2/3)"}),
                "r0": (dims3, col["r0"], {"long_name": "Fried parameter r0 (vertical, ground to top)", "units": "cm"}),
                "lsi2": (dims3, col["lsi2"], {"long_name": "log10 scintillation index (1550 nm, plane wave)", "units": "1"}),
            },
            coords={"lead": np.arange(N_LEADS), "z": Z_AGL_WRF, "lat": lat, "lon": lon},
        )  # fmt: skip
        info = {
            "Model": "SQF-H (wrf_pl)",
            "Inputs": "ERA5, nl test set 2017 (example data, not GFS)",
            "Correction": "nl-oQM",
        }
        notes = (
            f"**Example cycle** {cycle:%Y-%m-%d %H} UTC: hindcast of the nl test set, driven by ERA5 instead of GFS. "
            "Grid points outside the WRF domain are missing."
        )
        out = write_cycle(
            ds, DATA_ROOT, f"{cycle:%Y%m%d%H}", cycle, info=info, notes=notes
        )
        print(f"{out}: {sum(f.stat().st_size for f in out.iterdir()) / 1e6:.1f} MB, grid {len(lat)} x {len(lon)}, "
              f"{int(np.isfinite(grid[0, 0]).sum())} cells with data")  # fmt: skip
