#!/usr/bin/env python3
"""Convert the CDS GRIB files of step 1 to one zarr store in the ARCO layout of `era5.fetch` → `1_raw/era5.zarr`.

Month by month, in the download order of step 1 (`MONTHS`), every month whose GRIB files are complete; months still
downloading are skipped, so this can run any time during the download to update the store. 3-hourly, like the
download: the months downloaded hourly (`HOURLY` of step 1) are read at the same hours (`era5_cds.fetch`). The store is created for
the whole time window first (months not written yet are NaN) and each month is written to its region; the months in
the store are listed in `1_raw/era5.zarr.done` (see `list_months_in_store`, `open_store`). `--delete-grib` deletes each GRIB
file once all its months are in the store.
"""

import argparse

import pandas as pd
import xarray as xr
from otprof.sources import era5_cds
from step_1_download_era5 import AREA, END, HOURS, MONTHS, RAW, START, make_era5_jobs
from tqdm import tqdm

CHUNK = len(HOURS)  # time steps per zarr chunk: one day, so months start on chunk boundaries
STORE = RAW / "era5.zarr"
DONE_FILE = STORE.with_name(STORE.name + ".done")
TIMES = pd.date_range(START, pd.Period(END, freq="M").end_time, freq=f"{HOURS.step}h")  # time axis of the store


def list_months_in_store() -> list[str]:
    """The months written to the store, in download order."""
    return DONE_FILE.read_text().split() if DONE_FILE.exists() else []


def open_store() -> xr.Dataset:
    """The store, only the time steps of the months written so far."""
    ds = xr.open_zarr(STORE)
    return ds.sel(time=ds["time"].dt.strftime("%Y-%m").isin(list_months_in_store()))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--delete-grib", action="store_true", help="delete GRIB files once all their months are converted"
    )
    args = parser.parse_args()

    jobs = make_era5_jobs()
    grib = RAW / "cds"
    files = {m: [n for n, (_, r) in jobs.items() if m[:4] in r["year"] and m[5:] in r["month"]] for m in MONTHS}
    done = set(list_months_in_store())
    ready = [m for m in MONTHS if m not in done and all((grib / n).exists() for n in files[m])]
    n_left = len(MONTHS) - len(done) - len(ready)
    print(f"{len(done)} months in the store, {len(ready)} ready to convert, {n_left} not downloaded yet")
    if not ready:
        raise SystemExit(0)

    def open_month(month: str) -> xr.Dataset:
        return era5_cds.fetch(TIMES[TIMES.to_period("M") == month], AREA, grib)

    if not STORE.exists():
        first = open_month(ready[0])
        template = first.isel(time=0, drop=True).chunk().expand_dims(time=TIMES).chunk({"time": CHUNK})
        template.to_zarr(STORE, compute=False)  # metadata and coordinates only
        DONE_FILE.write_text("")

    for month in tqdm(ready, unit="month", dynamic_ncols=True):
        ds = open_month(month).chunk({"time": CHUNK})
        i = TIMES.get_loc(ds["time"].values[0])
        ds.drop_vars([c for c in ds.coords if "time" not in ds[c].dims]).to_zarr(
            STORE, region={"time": slice(i, i + ds.sizes["time"])}
        )
        with DONE_FILE.open("a") as f:
            f.write(month + "\n")
        done.add(month)
        if args.delete_grib:  # a file of a quarter holds up to 3 months: delete it once all of them are in the store
            for name in files[month]:
                if not all(m in done for m, names in files.items() if name in names):
                    continue
                (grib / name).unlink()
                for idx in grib.glob(f"{name}.*.idx"):  # cfgrib indexes
                    idx.unlink()
    print(f"{len(done)} of {len(MONTHS)} months in {STORE}")
