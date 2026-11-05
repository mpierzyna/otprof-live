"""Convert the statistics of step 4 to the web app's climatology (`otprof-live-clim/1`, docs/DATA_FORMAT.md) →
`WEBUI_DATA/climatology/`, with the statistics as NetCDF files for download, and list it in `WEBUI_DATA/index.json`.

Run again whenever the statistics are recomputed. Step 4 of the live pipeline (../live) uploads it with the cycles.

    uv run step_5_convert_webui.py [<directory of the files of step 4>]
"""

import pathlib
import sys

import xarray as xr
from shared import STATS_DIR, WEBUI_DATA, logger

from otprof_live.config import setup_logging
from otprof_live.webui import CLIM_DIR, write_index
from otprof_live.webui_climatology import write_climatology

if __name__ == "__main__":
    setup_logging()
    src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else STATS_DIR
    monthly, diurnal, violins_diurnal, violins_month = (
        xr.open_dataset(src / f"{name}.nc").load()
        for name in ("monthly", "diurnal", "violins_diurnal", "violins_month")
    )
    out = WEBUI_DATA / CLIM_DIR
    meta = write_climatology(monthly, diurnal, violins_diurnal, violins_month, out)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    logger.info(f"Wrote {out} ({size:.1f} MB, {meta['info']['Sample']})")

    write_index(WEBUI_DATA)  # the cycles stay as they are
    logger.info(f"Listed the climatology in {WEBUI_DATA / 'index.json'}")
