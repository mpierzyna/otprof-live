#!/usr/bin/env python3
"""Download 3-hourly ERA5 over the NL training area from 2005 on from the CDS (GRIB) → `GRIB_DIR` (`{pl,sl}/*.grib`).

Same area and variables as the training data of SQF-H. The quarters are downloaded one by one in the order of a Sobol
sequence over (year, quarter) (`download_quarters`): every prefix is a sample spread evenly over the years and seasons,
usable (step 2) long before the download is complete. Without `--download` only the plan is printed. Resumable: existing
files are skipped and submitted requests are picked up again from `requests.json` in `GRIB_DIR` instead of being queued
again. The plan is kept in `jobs.json` there, where `era5_cds.fetch` finds the files (step 2).
"""

import argparse

from otprof.sources import era5_cds
from shared import (
    AREA,
    END,
    GRIB_DIR,
    START,
    download_quarters,
    make_blocks,
    make_era5_jobs,
)

GRIB_BYTES_PER_FIELD = 1600  # measured on the NL area (25 x 29 points, 16-bit packing)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="download (default: print the plan only)")
    parser.add_argument("--max-active", type=int, default=8, help="requests queued or running at a time")
    args = parser.parse_args()

    jobs = make_era5_jobs()
    quarters = download_quarters()
    n_fields = sum(
        len(r["variable"]) * len(r.get("pressure_level", [0])) * len(r["month"]) * 31 * len(r["time"])
        for _, r in jobs.values()
    )  # upper bound: 31 days per month
    n_done = sum((GRIB_DIR / name).exists() for name in jobs)
    print(f"{START} .. {END}: {len(quarters)} quarters, {len(jobs)} CDS requests, {n_done} downloaded already")
    print(f"Order: {', '.join(quarters[:8])}, ...")
    print(f"Size to download: ~{n_fields * GRIB_BYTES_PER_FIELD / 1e9:.0f} GB (GRIB, {n_fields / 1e6:.1f} M fields)")
    if args.download:
        era5_cds.download(make_blocks(), AREA, GRIB_DIR, max_active=args.max_active)
        print("Done.")
