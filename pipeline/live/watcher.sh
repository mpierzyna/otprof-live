#!/bin/bash
# Watch for new GFS cycles: run the live pipeline (run.sh) every INTERVAL seconds (default 3600). Each run checks AWS
# for a cycle that is newer than the last one processed, processes and uploads it, or stops quietly if there is none.
# A failed run is logged and retried at the next check (an interrupted run is resumed). Stop with Ctrl-C or SIGTERM.
#
#   ./watcher.sh [INTERVAL]                                      in the foreground (or OTPROF_WATCH_INTERVAL)
#   nohup ./watcher.sh >> ../data/live/watcher.log 2>&1 &        in the background
#
# GFS cycles (00, 06, 12, 18 UTC) are complete on AWS ~4-5 h later, so hourly checks publish a cycle within an hour
# of its upload. To keep the watcher running across reboots, see pipeline/README.md (systemd user service).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

INTERVAL="${1:-${OTPROF_WATCH_INTERVAL:-3600}}"
log() { echo "$(date -u +%FT%TZ) watcher: $*"; }
trap 'log "stopped"; exit 0' INT TERM

log "checking for new GFS cycles every ${INTERVAL} s"
while true; do
    start=$(date +%s)
    ./run.sh
    status=$?
    if [[ ${status} -eq 0 ]]; then
        log "check done"
    else
        log "run failed (exit ${status}); retrying at the next check"
    fi
    wait_s=$((INTERVAL - ($(date +%s) - start)))
    if [[ ${wait_s} -gt 0 ]]; then
        sleep "${wait_s}" &
        wait $!  # in the background, so that a signal stops the watcher at once
    fi
done
