#!/bin/bash
# Mirror the web app's data root (WEBUI_DATA: the cycles of the forecast pipeline with their NetCDF for download, the
# climatology of its step 5) to the remote with rclone. Independent of both pipelines; does nothing if nothing changed.
#
#   ./upload.sh              upload
#   ./upload.sh --dry-run    show what would change, change nothing
#   ./upload.sh --config     set up the remote interactively (rclone config with the local config file)
#
# The rclone config is local to the pipeline (pipeline/.rclone.conf, git-ignored). The remote must be named "otprof" and
# point at the web app's data root, e.g. "otprof:/srv/otprof_data" (a path can be set with OTPROF_REMOTE_PATH).
# The remote ends up identical to WEBUI_DATA: files that are not there are deleted on the remote.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HERE}/.rclone.conf"
REMOTE="otprof:${OTPROF_REMOTE_PATH:-}"
RCLONE=(rclone --config "${CONFIG}")

if [[ "${1:-}" == "--config" ]]; then
    exec "${RCLONE[@]}" config
elif [[ "${1:-}" == "--dry-run" ]]; then
    RCLONE+=(--dry-run)
elif [[ $# -gt 0 ]]; then
    echo "Unknown option: $1" >&2
    exit 2
fi

SRC="$(cd "${HERE}" && uv run --quiet python -m otprof_live.config webui)"
if [[ ! -f "${CONFIG}" ]]; then
    echo "No rclone config at ${CONFIG}; run: $0 --config" >&2
    exit 1
fi
if [[ ! -f "${SRC}/index.json" ]]; then
    echo "Nothing to upload: ${SRC}/index.json missing (forecast step 3 not run?)" >&2
    exit 1
fi

# The pipelines do not write to the data root during the upload (`otprof_live.webui.data_root_lock`, the same lock)
exec 8> "${SRC}.lock"
flock 8

# New cycles first, then the index, then delete what is gone: the app never sees a cycle that is incomplete on the
# remote, and an index listing a deleted cycle only until the sync is done. Directories left by an interrupted write
# (*.part, the climatology of its step 5) stay local.
"${RCLONE[@]}" copy "${SRC}" "${REMOTE}" --exclude /index.json --exclude "/*.part/**"
"${RCLONE[@]}" copy "${SRC}/index.json" "${REMOTE}"
"${RCLONE[@]}" sync "${SRC}" "${REMOTE}" --exclude "/*.part/**"
echo "Synced ${SRC} to ${REMOTE}"
