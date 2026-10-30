"""Settings of the climatology pipeline (steps 1 to 5). Paths: `otprof_live.config` (env vars, pipeline/.env).

`CLIM_DATA` (`OTPROF_CLIM_DATA`, default pipeline/data/climatology) holds `1_raw/` (GRIB, ERA5 zarr), `3_predictions/`
and `4_climatology/`, ~250 GB in all. Step 5 writes the web app's climatology into `WEBUI_DATA`, the data root shared
with the live pipeline (../live), whose step 4 uploads it.
"""

from otprof_live.config import CLIM_DATA, WEBUI_DATA, logger  # noqa: F401 (used by the steps)
