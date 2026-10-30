#!/bin/bash
# Step 4: mirror the web app's data root (WEBUI_DATA: cycles of step 3, climatology of ../climatology step 5) to the
# remote with rclone. Independent of the run: a failed upload is repeated with the next one.
#
#   bash step_4_upload.sh            upload
#   bash step_4_upload.sh --config   set up the remote interactively (rclone config with the local config file)
#
# The rclone config is local to the pipeline (pipeline/.rclone.conf, git-ignored). The remote must be named "otprof" and
# point at the web app's data root, e.g. "otprof:/srv/otprof_data" (a path can be set with OTPROF_REMOTE_PATH).
# The remote ends up identical to WEBUI_DATA: files that are not there are deleted on the remote.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$(dirname "${HERE}")/.rclone.conf"
REMOTE="otprof:${OTPROF_REMOTE_PATH:-}"
RCLONE=(rclone --config "${CONFIG}")

if [[ "${1:-}" == "--config" ]]; then
    exec "${RCLONE[@]}" config
fi

SRC="$(cd "${HERE}" && uv run --quiet python -m otprof_live.config webui)"
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
