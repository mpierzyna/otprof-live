"""Writers of the web app's data formats (docs/DATA_FORMAT.md): forecast cycles (`otprof-live/1`, `write_cycle`) and the
index of a data root (`write_index`). The climatology: `webui_climatology`.

Values are stored as uint16 with scale and offset from their range (`quantize`), NaN as `FILL`. Each directory is
complete once its meta.json exists (written last), and the index lists only complete directories.
"""

import contextlib
import fcntl
import json
import pathlib
import shutil

import numpy as np
import pandas as pd
import xarray as xr

from otprof_live.config import logger

FORMAT = "otprof-live/1"
FILL = 65535
CLIM_DIR = "climatology"  # directory of the climatology in a data root

# Resolution of the stored values (forecast and climatology): log10 Cn2 to 0.01 (2.3 % in Cn2, below the model's
# error; the noise of a finer one does not compress: ~2.5 x larger with gzip). Others: the finest their range allows.
RESOLUTION = {"lcn2": 0.01}


@contextlib.contextmanager
def data_root_lock(data_root: pathlib.Path):
    """While writing to `data_root`: excludes the upload (../upload.sh takes the same lock) and the other pipeline. The
    lock file `<data_root>.lock` is beside the data root, so that it is not uploaded. Waits for the lock."""
    data_root.parent.mkdir(parents=True, exist_ok=True)
    with data_root.with_name(data_root.name + ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def quantize(vals: np.ndarray, resolution: float | None = None) -> tuple[np.ndarray, dict]:
    """`vals` as uint16 with scale and offset from their range (NaN = fill), and the encoding keys of the variable.
    `resolution`: the scale (coarser than the range allows: compresses better), else the finest for the range."""
    lo, hi = float(np.nanmin(vals)), float(np.nanmax(vals))
    scale = max(resolution or 0.0, (hi - lo) / (FILL - 1)) or 1.0
    stored = np.where(np.isnan(vals), FILL, np.round((vals - lo) / scale)).astype("<u2")
    return stored, {"dtype": "uint16", "scale": scale, "offset": lo, "fill": FILL, "valid_range": [lo, hi]}


def write_cycle(
    ds: xr.Dataset,
    data_root: pathlib.Path,
    cycle_id: str,
    cycle: pd.Timestamp,
    info: dict[str, str] | None = None,
    notes: str | None = None,
    download: str | None = None,
) -> pathlib.Path:
    """Write `ds` as cycle `cycle_id` (directory name) initialised at `cycle` (UTC) below `data_root`, as uint16 with
    scale and offset from the data range per variable (scale `RESOLUTION` if there). `notes`: markdown of the cycle.
    `download`: name of a file in the cycle directory (written before) that the app offers for download.

    `ds`: coords lead (hours), z (m above ground, if any variable has it), lat, lon (increasing); variables
    (lead, z, lat, lon) or (lead, lat, lon), NaN = missing."""
    out = data_root / cycle_id
    out.mkdir(parents=True, exist_ok=True)
    variables = {}
    for name, da in ds.data_vars.items():
        dims = ["lead", "z", "lat", "lon"] if "z" in da.dims else ["lead", "lat", "lon"]
        vals = da.transpose(*dims).values.astype(np.float64)
        stored, encoding = quantize(vals, RESOLUTION.get(name))
        var = {
            "long_name": da.attrs.get("long_name", name),
            "units": da.attrs.get("units", ""),
            "dims": dims,
            **encoding,
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
    if download is not None:
        meta["download"] = {"file": download, "bytes": (out / download).stat().st_size}
    # meta.json last: a cycle directory with meta.json is complete
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    return out


def write_index(data_root: pathlib.Path, keep: int | None = None) -> list[str]:
    """`data_root/index.json` with the complete cycles (with meta.json) in `data_root`, newest first, and the
    climatology if there is one. With `keep`, only the newest `keep` cycles are listed and the directories of the
    older ones are deleted."""
    cycles = sorted((f.parent.name for f in data_root.glob("*/meta.json") if f.parent.name.isdigit()), reverse=True)
    if not cycles:
        raise FileNotFoundError(f"No forecast cycle in {data_root}: the app needs at least one (live pipeline, step 3)")
    for old in cycles[keep:] if keep else []:
        logger.info(f"Deleting old cycle {old}")
        shutil.rmtree(data_root / old)
    cycles = cycles[:keep]
    index = {"format": FORMAT, "cycles": cycles, "latest": cycles[0]}
    if (data_root / CLIM_DIR / "meta.json").exists():
        index["climatology"] = f"{CLIM_DIR}/"
    (data_root / "index.json").write_text(json.dumps(index, indent=1))
    return cycles
