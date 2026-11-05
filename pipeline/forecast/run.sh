#!/bin/bash
# One run of the forecast pipeline: the newest GFS cycle (step 0) → download, predict, convert (steps 1-3) into the web
# app's data; ../upload.sh publishes them (../watcher.sh runs both). Stops quietly if the newest cycle is processed
# already; an interrupted run is resumed by the next call. Only one run at a time (lock file).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

exec 9> .run.lock
if ! flock -n 9; then
    echo "$(date -u +%FT%TZ) Another run is in progress; exiting."
    exit 0
fi

status=0
uv run step_0_prepare.py || status=$?
if [[ ${status} -eq 99 ]]; then  # EXIT_NOTHING_NEW of shared.py
    exit 0
elif [[ ${status} -ne 0 ]]; then
    exit "${status}"
fi
uv run step_1_download_gfs.py
uv run step_2_predict.py
uv run step_3_convert.py
