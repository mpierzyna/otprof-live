"""Step 1: download the lead times `LEADS` of the run's GFS cycle (picked by step 0) in `AREA_NL` →
`1_raw/gfs_<cycle>+<lead>.nc`.

GFS comes from the NOAA archive on AWS (no account needed). Lead times that are downloaded already are skipped, so an
interrupted download continues where it stopped.
"""

import logging
import tempfile

import tqdm
from otprof.sources import gfs

from shared import (
    AREA_NL,
    CYCLE_FORMAT,
    LEADS,
    RUNNING_DIR,
    get_running_cycle,
    logger,
    to_netcdf,
)

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    out_dir = RUNNING_DIR / "1_raw"
    out_dir.mkdir(exist_ok=True)

    cycle = get_running_cycle()
    cycle_str = cycle.strftime(CYCLE_FORMAT)

    logger.info(f"Downloading GFS cycle {cycle} for leads {LEADS[0]}-{LEADS[-1]} h")
    for l in tqdm.tqdm(LEADS, desc="Downloading GFS leads"):
        # Skip download if the file already exists
        part_name = f"gfs_{cycle_str}+{l:03d}.nc"
        if (out_dir / part_name).exists():
            logger.debug(f"{part_name} already exists; skipping download.")
            continue

        # Download to tmp_file first to avoid partial files in case of interruption
        with tempfile.TemporaryFile() as tmp_file:
            logger.debug(f"Downloading {part_name}...")
            part = gfs.fetch_lead(cycle, lead=l, where=AREA_NL, n_threads=16)
            to_netcdf(part, tmp_file, engine="h5netcdf")

            # Once the temporary file is written, move it to the final destination
            with open(out_dir / part_name, "wb") as f_out:
                tmp_file.seek(0)
                f_out.write(tmp_file.read())

    logger.info("Download successful.")
