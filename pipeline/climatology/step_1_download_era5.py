#!/usr/bin/env python3
"""Download 3-hourly ERA5 over the NL training area from 2005 on from the CDS (GRIB) → `1_raw/cds/{pl,sl}/*.grib`
(below `CLIM_DATA`, see shared.py).

Same area and variables as the training data of SQF-H. The quarters are downloaded one by one in the order of a Sobol
sequence over (year, quarter) (`QUARTERS`): every prefix is a sample spread evenly over the years and seasons, usable
(step 2) long before the download is complete. Without `--download` only the plan is printed. Resumable: existing
files are skipped and submitted requests are picked up again from `1_raw/cds/requests.json` instead of being queued
again. The plan is kept in `1_raw/cds/jobs.json`, where `era5_cds.fetch` finds the files (step 2).
"""

import argparse

import pandas as pd
from otprof.sources import Area, era5_cds
from shared import CLIM_DATA

RAW = CLIM_DATA / "1_raw"
START, END = "2005-01", "2026-06"  # END: last month of final ERA5 (later months are the preliminary ERA5T)
HOURS = range(0, 24, 3)  # UTC
GRIB_BYTES_PER_FIELD = 1600  # measured on the NL area (25 x 29 points, 16-bit packing)
AREA = Area(lon_min=2, lon_max=9, lat_min=49, lat_max=55)  # the NL training area of SQF-H


def order_quarters_sobol(start: str, end: str, *, seed: int = 0) -> list[str]:
    """The quarters of `start` .. `end` (e.g. "2005-01", "2026-06"; whole quarters) in the order of a scrambled 2D
    Sobol sequence over (year, quarter): every prefix of the list spreads evenly over the years and over the seasons.

    Points falling on a quarter out of range or already taken are skipped. Deterministic for a given `seed`.
    """
    from scipy.stats import qmc

    todo = {str(q) for q in pd.period_range(start, end, freq="Q")}
    years = sorted({int(q[:4]) for q in todo})
    sampler = qmc.Sobol(d=2, scramble=True, seed=seed)
    order: list[str] = []
    while todo:
        assert sampler.num_generated < 2**20, f"Sobol sequence did not reach {sorted(todo)}"
        for a, b in sampler.random(1024):  # powers of 2 keep the balance of the sequence
            quarter = f"{years[int(a * len(years))]}Q{int(b * 4) + 1}"
            if quarter in todo:
                todo.remove(quarter)
                order.append(quarter)
    return order


def list_months(quarter: str) -> list[str]:
    """The months of `quarter` (e.g. "2017Q1")."""
    first = pd.Period(quarter, "Q").asfreq("M", "start")
    return [str(m) for m in pd.period_range(first, first + 2)]


QUARTERS = order_quarters_sobol(START, END, seed=0)  # download order; fixed seed: the same order on every run
MONTHS = [m for q in QUARTERS for m in list_months(q)]  # download order


def make_times(months: list[str], freq: str) -> pd.DatetimeIndex:
    """All times of `months` (e.g. ["2017-01"]) at `freq` (e.g. "3h")."""
    return pd.DatetimeIndex([t for m in months for t in pd.date_range(m, pd.Period(m, "M").end_time, freq=freq)])


def make_blocks() -> list[pd.DatetimeIndex]:
    """The time blocks in download order: the months of each quarter, 3-hourly."""
    return [make_times(list_months(q), f"{HOURS.step}h") for q in QUARTERS]


def make_era5_jobs() -> era5_cds.Jobs:
    """The CDS requests in download order: {file name in `1_raw/cds`: job}, one block per quarter, e.g.
    `pl/2014_01-03_<i>.grib`."""
    return era5_cds.make_jobs(make_blocks(), AREA)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="download (default: print the plan only)")
    parser.add_argument("--max-active", type=int, default=8, help="requests queued or running at a time")
    args = parser.parse_args()

    jobs = make_era5_jobs()
    n_fields = sum(
        len(r["variable"]) * len(r.get("pressure_level", [0])) * len(r["month"]) * 31 * len(r["time"])
        for _, r in jobs.values()
    )  # upper bound: 31 days per month
    n_done = sum((RAW / "cds" / name).exists() for name in jobs)
    print(f"{START} .. {END}: {len(QUARTERS)} quarters, {len(jobs)} CDS requests, {n_done} downloaded already")
    print(f"Order: {', '.join(QUARTERS[:8])}, ...")
    print(f"Size to download: ~{n_fields * GRIB_BYTES_PER_FIELD / 1e9:.0f} GB (GRIB, {n_fields / 1e6:.1f} M fields)")
    if args.download:
        era5_cds.download(make_blocks(), AREA, RAW / "cds", max_active=args.max_active)
        print("Done.")
