#!/bin/bash
# Every INTERVAL seconds (default 3600): process a new GFS cycle (forecast/run.sh, stops quietly if there is none), then
# mirror the web app's data to the server (upload.sh). The upload runs on every check, whatever the forecast did: a failed
# upload is repeated within the hour, and a new climatology goes out with the next check. A failed run is logged and
# retried at the next check (an interrupted forecast run is resumed). Stop with Ctrl-C or SIGTERM.
#
#   ./watcher.sh [INTERVAL]                                      in the foreground (or OTPROF_WATCH_INTERVAL)
#   nohup ./watcher.sh >> data/watcher.log 2>&1 &                in the background
#
# GFS cycles (00, 06, 12, 18 UTC) are complete on AWS ~4-5 h later, so hourly checks publish a cycle within an hour of
# its upload. To keep the watcher running across reboots: systemd/otprof-watcher.service, see README.md.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

INTERVAL="${1:-${OTPROF_WATCH_INTERVAL:-3600}}"
log() { echo "$(date -u +%FT%TZ) watcher: $*"; }
trap 'log "stopped"; exit 0' INT TERM

run() {  # <name> <command...>: logs a failure, never stops the watcher
    local name="$1"
    shift
    "$@"
    local status=$?
    if [[ ${status} -ne 0 ]]; then
        log "${name} failed (exit ${status}); retrying at the next check"
    fi
}

log "checking for new GFS cycles every ${INTERVAL} s"
while true; do
    start=$(date +%s)
    run forecast forecast/run.sh
    run upload ./upload.sh
    log "check done"
    wait_s=$((INTERVAL - ($(date +%s) - start)))
    if [[ ${wait_s} -gt 0 ]]; then
        sleep "${wait_s}" &
        wait $!  # in the background, so that a signal stops the watcher at once
    fi
done
