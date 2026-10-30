#!/bin/bash
# Step 4: mirror the web app's data root (data_webui, written by step 3) to the remote with rclone.
#
#   bash step_4_upload.sh            upload
#   bash step_4_upload.sh --config   set up the remote interactively (rclone config with the local config file)
#
# The rclone config is local to the pipeline (.rclone.conf, git-ignored). The remote must be named "otprof" and point
# at the web app's data root, e.g. "otprof:/srv/otprof_data" (a path can be set with OTPROF_REMOTE_PATH).
# The remote ends up identical to data_webui: files that are not in data_webui are deleted there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${HERE}/.rclone.conf"
REMOTE="otprof:${OTPROF_REMOTE_PATH:-}"
SRC="${HERE}/data_webui"
RCLONE=(rclone --config "${CONFIG}")

if [[ "${1:-}" == "--config" ]]; then
    exec "${RCLONE[@]}" config
fi

if [[ ! -f "${CONFIG}" ]]; then
    echo "No rclone config at ${CONFIG}; run: bash $0 --config" >&2
    exit 1
fi
if [[ ! -f "${SRC}/index.json" ]]; then
    echo "Nothing to upload: ${SRC}/index.json missing (step 3 not run?)" >&2
    exit 1
fi

# New cycles first, then the index, then delete what is gone: the app never sees a cycle that is incomplete on the
# remote, and an index listing a deleted cycle only until the sync is done
"${RCLONE[@]}" copy "${SRC}" "${REMOTE}" --exclude /index.json
"${RCLONE[@]}" copy "${SRC}/index.json" "${REMOTE}"
"${RCLONE[@]}" sync "${SRC}" "${REMOTE}"
echo "Synced ${SRC} to ${REMOTE}"

# Remove running dir symlink 
rm "${HERE}/data/running"
