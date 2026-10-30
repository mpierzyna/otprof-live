"""Step 5: convert the climatology of step 4 (`CLIM_DATA/4_climatology`) to the web app's climatology format
`otprof-live-clim/1` (docs/DATA_FORMAT.md) → `WEBUI_DATA/climatology/`, and list it in `WEBUI_DATA/index.json`.

Run again whenever the climatology is recomputed. Step 4 of the live pipeline (../live) uploads it with the cycles.

    uv run step_5_convert_webui.py [<4_climatology dir>]

Per calendar month and grid point: the statistics `CLIM_STATS` of lcn2 (per height), r0 and lsi2 (`grid_month.nc`),
the log10 of the mean linear Cn2 as the extra statistic `lmean` of lcn2, and the diurnal cycle (3-hourly, UTC) of r0
and lsi2 with the same statistics (`grid_month_hour.nc`) and as densities for violin plots
(`grid_month_hour_violin.nc`, if there).
"""

import pathlib
import sys

import xarray as xr
from shared import CLIM_DATA, WEBUI_DATA, logger

from otprof_live.config import setup_logging
from otprof_live.webui import CLIM_DIR, to_grid, write_climatology, write_index

if __name__ == "__main__":
    setup_logging()
    src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else CLIM_DATA / "4_climatology"

    grid = to_grid(xr.open_dataset(src / "grid_month.nc")).load()
    diurnal = to_grid(xr.open_dataset(src / "grid_month_hour.nc")).load()
    violin_file = src / "grid_month_hour_violin.nc"
    violin = to_grid(xr.open_dataset(violin_file)).load() if violin_file.exists() else None
    if violin is None:
        logger.warning(f"{violin_file} missing (step 4 before the violin plots): the app shows box plots only")
    out = WEBUI_DATA / CLIM_DIR
    meta = write_climatology(grid, diurnal, out, violin)
    size = sum(f.stat().st_size for f in out.iterdir()) / 1e6
    logger.info(f"Wrote {out} ({size:.1f} MB, {meta['info']['Sample']})")

    write_index(WEBUI_DATA)  # the cycles stay as they are
    logger.info(f"Listed the climatology in {WEBUI_DATA / 'index.json'}")
