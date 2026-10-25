#!/bin/sh
# Rebuild and restart the app when the deployed branch has new commits; run from cron (README, Deploy).
# --force rebuilds anyway (e.g. weekly, for updated base images).
set -eu
cd "$(dirname "$0")/.."
branch=${OTPROF_LIVE_BRANCH:-main}

git fetch -q origin "$branch"
new=$(git rev-parse FETCH_HEAD)
if [ "${1:-}" != --force ] && [ "$new" = "$(cat .deployed 2>/dev/null)" ]; then
    exit 0
fi
git merge -q --ff-only "$new"
echo "$(date -Is) deploying $(git log -1 --format='%h %s')"
docker compose build --pull -q
docker compose up -d --wait
docker image prune -f > /dev/null
echo "$new" > .deployed
