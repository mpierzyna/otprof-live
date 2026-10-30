"""Step 0: pick the GFS cycle of this run and prepare its run directory `data/<cycle>/` (linked as `data/running`).

    uv run step_0_prepare.py [--cycle 2026-10-29T06:00]

- `data/running` exists: an interrupted run is resumed with its own cycle; nothing changes.
- otherwise the cycle is `--cycle` (from Airflow's `WaitForGfsCycle`) or the newest one that is complete on AWS. If its
  run directory exists already, the cycle is processed: exit with `EXIT_NOTHING_NEW` (Airflow skips the other steps).
"""

import argparse
import datetime
import logging
import sys

from otprof.sources import gfs

from shared import CYCLE_FORMAT, DATA_ROOT, EXIT_NOTHING_NEW, LEADS, RUNNING_DIR, logger


def get_current_cycle() -> datetime.datetime:
    """Get the current GFS cycle (00, 06, 12, 18 UTC) based on the current time."""
    now = datetime.datetime.now(tz=datetime.UTC)
    now = now.replace(tzinfo=None)  # Remove timezone to not cause xarray issues
    cycle_hour = (now.hour // 6) * 6
    cycle = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    return cycle


def get_latest_cycle(last_lead: int, max_back: int = 4) -> datetime.datetime:
    """The newest GFS cycle that is complete on AWS up to `last_lead`: a run takes about 4-5 h to be uploaded, so the
    current cycle is often not there yet. Looks back at most `max_back` cycles."""
    cycle = get_current_cycle()
    for _ in range(max_back + 1):
        if gfs.is_cycle_available(cycle, last_lead):
            return cycle
        logger.info(f"GFS cycle {cycle} not complete on AWS yet (lead {last_lead} missing)")
        cycle -= datetime.timedelta(hours=6)
    raise RuntimeError(f"No complete GFS cycle on AWS in the last {max_back + 1} cycles")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cycle", type=datetime.datetime.fromisoformat, help="GFS cycle (default: newest on AWS)")
    args = parser.parse_args()

    if RUNNING_DIR.exists():
        logger.warning(f"{RUNNING_DIR} -> {RUNNING_DIR.resolve().name} exists: resuming the unfinished run.")
        sys.exit(0)
    if RUNNING_DIR.is_symlink():  # dangling: its run directory was deleted
        logger.warning(f"{RUNNING_DIR} points to a missing directory; removing it.")
        RUNNING_DIR.unlink()

    cycle = args.cycle or get_latest_cycle(last_lead=LEADS[-1])
    work_dir = DATA_ROOT / cycle.strftime(CYCLE_FORMAT)
    if work_dir.exists():
        logger.info(f"GFS cycle {cycle} is processed already ({work_dir}). Nothing to do.")
        sys.exit(EXIT_NOTHING_NEW)

    work_dir.mkdir(parents=True)
    RUNNING_DIR.symlink_to(work_dir.name)  # relative, so the data directory can be moved
    logger.info(f"Starting run of GFS cycle {cycle} in {work_dir}")
