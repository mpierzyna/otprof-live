"""Prepare directory structure for the pipeline."""

import datetime
import sys

from shared import DATA_ROOT, RUNNING_DIR, logger

if RUNNING_DIR.exists():
    logger.warning(
        "Running directory already exists. "
        "Either pipeline crashed or didn't finish. Won't create new. Exiting."
    )
    sys.exit(0)


# Create new working dir
WORK_DIR = DATA_ROOT / datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
WORK_DIR.mkdir(parents=True, exist_ok=False)
RUNNING_DIR.symlink_to(WORK_DIR)
