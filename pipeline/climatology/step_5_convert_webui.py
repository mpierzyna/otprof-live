"""Step 5: convert the climatology of step 4 (`CLIM_DATA/4_climatology`) to the web app's climatology format
`otprof-live-clim/1` (docs/DATA_FORMAT.md) → `WEBUI_DATA/climatology/`, and list it in `WEBUI_DATA/index.json`.

Run again whenever the climatology is recomputed. Step 4 of the live pipeline (../live) uploads it with the cycles.

    uv run step_5_convert_webui.py [<4_climatology dir>]

Per calendar month and grid point: the statistics `CLIM_STATS` of lcn2 (per height), r0 and lsi2 (`grid_month.nc`),
the log10 of the mean of the linear values (cn2, si2) as the extra statistic `lmean` of lcn2 and lsi2, and the diurnal
cycle (3-hourly, UTC) of lcn2 (one file per grid point), r0 and lsi2 with the same statistics (`grid_month_hour.nc`) and as densities for violin
plots (`grid_month_hour_violin.nc`, if there; lsi2 also of the linear si2, `violin_linear`), and the densities per
month for violin plots of the annual cycle (`grid_month_violin.nc`, if there: `violin_month`, `violin_month_linear`).
The same for day and night (`grid_month_day.nc`, `grid_month_night.nc`, if there: `periods`), and with them the Cn2
profiles for download: a zip of three CSV files (global, day, night) per month and grid point (`csv`).
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
    month_file = src / "grid_month_violin.nc"
    violin_month = to_grid(xr.open_dataset(month_file)).load() if month_file.exists() else None
    if violin_month is None:
        logger.warning(f"{month_file} missing (step 4 before the violins per month): the annual cycle as box plots only")
    periods = {}
    for period in ("day", "night"):
        file = src / f"grid_month_{period}.nc"
        if file.exists():
            periods[period] = to_grid(xr.open_dataset(file)).load()
        else:
            logger.warning(f"{file} missing (step 4 before day and night): the app shows global statistics only, no CSV")
    if len(periods) < 2:
        periods = {}
    out = WEBUI_DATA / CLIM_DIR
    meta = write_climatology(grid, diurnal, out, violin, violin_month, periods)
    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) / 1e6
    logger.info(f"Wrote {out} ({size:.1f} MB, {meta['info']['Sample']})")

    write_index(WEBUI_DATA)  # the cycles stay as they are
    logger.info(f"Listed the climatology in {WEBUI_DATA / 'index.json'}")
