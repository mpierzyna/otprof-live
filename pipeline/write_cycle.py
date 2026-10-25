"""Reference writer of the otprof-live/1 data format (docs/DATA_FORMAT.md).

write_cycle(ds, data_root, cycle_id) writes one forecast cycle from an xarray Dataset with
  coords  lead (hours), z (m above ground, if any variable has it), lat, lon (increasing)
  vars    (lead, z, lat, lon) or (lead, lat, lon), NaN = missing
and adds the cycle to data_root/index.json (newest first).
"""

from __future__ import annotations

import json
import pathlib

import numpy as np
import pandas as pd
import xarray as xr

FORMAT = "otprof-live/1"
FILL = 65535


def write_cycle(
    ds: xr.Dataset,
    data_root: pathlib.Path,
    cycle_id: str,
    cycle: pd.Timestamp,
    info: dict[str, str] | None = None,
    notes: str | None = None,
    keep: int | None = None,
) -> pathlib.Path:
    """Write `ds` as cycle `cycle_id` (directory name) initialised at `cycle` (UTC) below `data_root`, as uint16 with
    scale and offset from the data range per variable. `notes`: markdown of the cycle. `keep`: number of cycles kept in
    index.json (older ones are dropped from the index, their directories are left alone)."""
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
    (out / "meta.json").write_text(json.dumps(meta, indent=1))

    # Publish: add to the index only once the cycle is complete
    index_file = data_root / "index.json"
    cycles = json.loads(index_file.read_text())["cycles"] if index_file.exists() else []
    cycles = sorted({*cycles, cycle_id}, reverse=True)[:keep]
    index_file.write_text(json.dumps({"format": FORMAT, "cycles": cycles, "latest": cycles[0]}, indent=1))
    return out
