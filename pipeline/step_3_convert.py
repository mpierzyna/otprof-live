"""Step 3: convert the predictions `2_prediction/preds.nc` of the running pipeline to the web app's data format
`otprof-live/1` (docs/DATA_FORMAT.md) → `WEBUI_ROOT` (`data_webui/`).

`data_webui/` is the web app's data root, which step 4 mirrors to the remote:
  data_webui/index.json         the cycles in data_webui/, newest first
  data_webui/<YYYYMMDDHH>/      one directory per cycle (meta.json, *.bin)
Only the newest `KEEP_CYCLES` cycles are kept; older cycle directories are deleted (they can be written again from
the runs' predictions).
"""

from __future__ import annotations

import json
import logging
import pathlib
import shutil

import numpy as np
import pandas as pd
import xarray as xr

from shared import RUNNING_DIR, WEBUI_ROOT, logger

FORMAT = "otprof-live/1"
FILL = 65535
VARIABLES = ["lcn2", "r0", "lsi2"]  # exported, in this order (the app shows them in this order)
KEEP_CYCLES = 8  # cycles kept in data_webui/ (2 days of 6-hourly cycles)
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


def write_cycle(
    ds: xr.Dataset,
    data_root: pathlib.Path,
    cycle_id: str,
    cycle: pd.Timestamp,
    info: dict[str, str] | None = None,
    notes: str | None = None,
) -> pathlib.Path:
    """Write `ds` as cycle `cycle_id` (directory name) initialised at `cycle` (UTC) below `data_root`, as uint16 with
    scale and offset from the data range per variable. `notes`: markdown of the cycle.

    `ds`: coords lead (hours), z (m above ground, if any variable has it), lat, lon (increasing); variables
    (lead, z, lat, lon) or (lead, lat, lon), NaN = missing."""
    out = data_root / cycle_id
    out.mkdir(parents=True, exist_ok=True)
    variables = {}
    for name, da in ds.data_vars.items():
        dims = ["lead", "z", "lat", "lon"] if "z" in da.dims else ["lead", "lat", "lon"]
        vals = da.transpose(*dims).values.astype(np.float64)
        lo, hi = float(np.nanmin(vals)), float(np.nanmax(vals))
        scale = (hi - lo) / (FILL - 1) or 1.0
        stored = np.where(np.isnan(vals), FILL, np.round((vals - lo) / scale)).astype("<u2")
        var = {
            "long_name": da.attrs.get("long_name", name),
            "units": da.attrs.get("units", ""),
            "dims": dims,
            "dtype": "uint16",
            "scale": scale,
            "offset": lo,
            "fill": FILL,
            "valid_range": [lo, hi],
            "display_range": [float(q) for q in np.nanpercentile(vals, [1, 99])],
        }
        if "z" in dims:  # colour range per height: lcn2 spans orders of magnitude over the column
            q = np.nanpercentile(vals, [1, 99], axis=(0, 2, 3))
            var["display_range_z"] = [[float(a), float(b)] for a, b in q.T]
            var["files"] = [f"{name}_f{int(h):03d}.bin" for h in ds["lead"].values]
            for f, block in zip(var["files"], stored):
                (out / f).write_bytes(block.tobytes())
        else:
            var["file"] = f"{name}.bin"
            (out / var["file"]).write_bytes(stored.tobytes())
        variables[name] = var

    meta = {
        "format": FORMAT,
        "cycle": f"{cycle:%Y-%m-%dT%H:%M:%SZ}",
        "lead_hours": [float(h) for h in ds["lead"].values],
        "lat": [round(float(v), 5) for v in ds["lat"].values],
        "lon": [round(float(v), 5) for v in ds["lon"].values],
        "info": info or {},
        "variables": variables,
    }
    if "z" in ds.coords:
        meta["z_agl"] = [round(float(v), 2) for v in ds["z"].values]
    if notes is not None:
        (out / "notes.md").write_text(notes)
        meta["notes"] = "notes.md"
    # meta.json last: a cycle directory with meta.json is complete
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    return out


def write_index(data_root: pathlib.Path, keep: int | None = None) -> list[str]:
    """`data_root/index.json` with the complete cycles (with meta.json) in `data_root`, newest first. With `keep`,
    only the newest `keep` cycles are listed and the directories of the older ones are deleted."""
    cycles = sorted((f.parent.name for f in data_root.glob("*/meta.json")), reverse=True)
    for old in cycles[keep:] if keep else []:
        logger.info(f"Deleting old cycle {old}")
        shutil.rmtree(data_root / old)
    cycles = cycles[:keep]
    index = {"format": FORMAT, "cycles": cycles, "latest": cycles[0]}
    (data_root / "index.json").write_text(json.dumps(index, indent=1))
    return cycles


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    preds = xr.open_dataset(RUNNING_DIR / "2_prediction" / "preds.nc").load()
    ds, cycle = to_grid(preds)
    info = INFO if preds.attrs.get("otprof_oqm") else {k: v for k, v in INFO.items() if k != "Correction"}

    cycle_dir = write_cycle(ds, WEBUI_ROOT, f"{cycle:%Y%m%d%H}", cycle, info=info)
    size = sum(f.stat().st_size for f in cycle_dir.iterdir()) / 1e6
    logger.info(f"Wrote {cycle_dir} ({size:.1f} MB, {ds.sizes['lead']} leads, {ds.sizes['z']} heights)")

    cycles = write_index(WEBUI_ROOT, keep=KEEP_CYCLES)
    logger.info(f"Wrote index with cycles {cycles}")
