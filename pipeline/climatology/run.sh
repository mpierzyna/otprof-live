#!/bin/bash
# Update the climatology from what step 1 has downloaded so far: convert (step 2), predict (3), statistics (4), web app
# format (5). The download (step 1) runs on its own for days: uv run step_1_download_era5.py --download
# Live step 4 uploads the result with the next forecast run (or: bash ../live/step_4_upload.sh).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

exec 9> .run.lock
if ! flock -n 9; then
    echo "Another climatology update is in progress; exiting."
    exit 0
fi

uv run step_2_to_zarr.py "$@"  # e.g. --delete-grib
uv run step_3_predict.py
uv run step_4_climatology.py
uv run step_5_convert_webui.py
