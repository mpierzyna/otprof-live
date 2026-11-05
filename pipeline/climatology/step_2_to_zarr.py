#!/usr/bin/env python3
"""Convert the CDS GRIB files of step 1 to one zarr store in the ARCO layout of `era5.fetch` → `ERA5_STORE`.

Month by month, in the download order of step 1, every month whose GRIB files are complete; months still downloading are
skipped, so this can run any time during the download to update the store. 3-hourly, like the download. The store is
created for the whole time window first (months not written yet are NaN) and each month is written to its region; the
months in the store are listed next to it (`list_months_done`, `open_done`). `--delete-grib` deletes each GRIB file once
all its months are in the store.
"""

import argparse

import xarray as xr
from otprof.sources import era5_cds
from shared import (
    AREA,
    ERA5_STORE,
    GRIB_DIR,
    HOURS,
    TIMES,
    done_file,
    download_months,
    list_months_done,
    make_era5_jobs,
)
from tqdm import tqdm

CHUNK = len(HOURS)  # time steps per zarr chunk: one day, so months start on chunk boundaries

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--delete-grib", action="store_true", help="delete GRIB files once all their months are converted"
    )
    args = parser.parse_args()

    jobs = make_era5_jobs()
    months = download_months()
    files = {m: [n for n, (_, r) in jobs.items() if m[:4] in r["year"] and m[5:] in r["month"]] for m in months}
    done = set(list_months_done(ERA5_STORE))
    ready = [m for m in months if m not in done and all((GRIB_DIR / n).exists() for n in files[m])]
    n_left = len(months) - len(done) - len(ready)
    print(f"{len(done)} months in the store, {len(ready)} ready to convert, {n_left} not downloaded yet")
    if not ready:
        raise SystemExit(0)

    def open_month(month: str) -> xr.Dataset:
        return era5_cds.fetch(TIMES[TIMES.to_period("M") == month], AREA, GRIB_DIR)

    if not ERA5_STORE.exists():
        first = open_month(ready[0])
        template = first.isel(time=0, drop=True).chunk().expand_dims(time=TIMES).chunk({"time": CHUNK})
        template.to_zarr(ERA5_STORE, compute=False)  # metadata and coordinates only
        done_file(ERA5_STORE).write_text("")

    for month in tqdm(ready, unit="month", dynamic_ncols=True):
        ds = open_month(month).chunk({"time": CHUNK})
        i = TIMES.get_loc(ds["time"].values[0])
        ds.drop_vars([c for c in ds.coords if "time" not in ds[c].dims]).to_zarr(
            ERA5_STORE, region={"time": slice(i, i + ds.sizes["time"])}
        )
        with done_file(ERA5_STORE).open("a") as f:
            f.write(month + "\n")
        done.add(month)
        if args.delete_grib:  # a file of a quarter holds up to 3 months: delete it once all of them are in the store
            for name in files[month]:
                if not all(m in done for m, names in files.items() if name in names):
                    continue
                (GRIB_DIR / name).unlink()
                for idx in GRIB_DIR.glob(f"{name}.*.idx"):  # cfgrib indexes
                    idx.unlink()
    print(f"{len(done)} of {len(months)} months in {ERA5_STORE}")
