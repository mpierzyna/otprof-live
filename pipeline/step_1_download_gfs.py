"""Step 1: download the GFS forecast of `params.yaml` at the locations → `data/gfs.nc`.

GFS comes from the NOAA archive on AWS (no account needed). Only the needed fields are downloaded (a few MB per lead
time), from the grid points nearest to the locations. Delete the file to download again.
"""

import datetime
import logging
import tempfile

import tqdm
from otprof.sources import gfs

from shared import AREA_NL, RUNNING_DIR, logger, to_netcdf


def get_current_cycle() -> datetime.datetime:
    """Get the current GFS cycle (00, 06, 12, 18 UTC) based on the current time."""
    now = datetime.datetime.now(tz=datetime.UTC)
    now = now.replace(tzinfo=None)  # Remove timezone to not cause xarray issues
    cycle_hour = (now.hour // 6) * 6
    cycle = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    return cycle


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    out_dir = RUNNING_DIR / "1_raw"
    out_dir.mkdir(exist_ok=True)

    cycle = get_current_cycle()
    cycle_str = cycle.strftime("%Y%m%dT%H")
    leads = range(1, 121, 1)  # 1 to 120 hours, every hour

    logger.info(f"Downloading GFS cycle {cycle} for leads {list(leads)}")
    for l in tqdm.tqdm(leads, desc="Downloading GFS leads"):
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
