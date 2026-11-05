"""Step 1: download the lead times `LEADS` of the run's GFS cycle (picked by step 0) in `AREA_NL` →
`1_raw/gfs_<cycle>+<lead>.nc`.

GFS comes from the NOAA archive on AWS (no account needed). Each file is written as `.part` and renamed when complete,
so lead times that exist are complete: an interrupted download continues where it stopped.
"""

import tqdm
from otprof.sources import gfs
from shared import (
    AREA_NL,
    CYCLE_FORMAT,
    LEADS,
    RUNNING_DIR,
    get_running_cycle,
    logger,
    to_netcdf_atomic,
)

from otprof_live.config import setup_logging

if __name__ == "__main__":
    setup_logging()

    cycle = get_running_cycle()
    cycle_str = cycle.strftime(CYCLE_FORMAT)
    out_dir = RUNNING_DIR / "1_raw"
    out_dir.mkdir(exist_ok=True)

    logger.info(f"Downloading GFS cycle {cycle} for leads {LEADS[0]}-{LEADS[-1]} h")
    for lead in tqdm.tqdm(LEADS, desc="Downloading GFS leads"):
        path = out_dir / f"gfs_{cycle_str}+{lead:03d}.nc"
        if path.exists():
            logger.debug(f"{path.name} already exists; skipping download.")
            continue
        part = gfs.fetch_lead(cycle, lead=lead, where=AREA_NL, n_threads=16)
        to_netcdf_atomic(part, path, engine="h5netcdf")

    logger.info("Download successful.")
