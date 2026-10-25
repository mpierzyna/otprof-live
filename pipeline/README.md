# Pipeline (placeholder)

The operational forecast job goes here: per GFS cycle, download the inputs, predict with OTProf on the grid, apply the
output quantile mapping, compute r0 and lsi2, and publish with `write_cycle.write_cycle` (format:
`../docs/DATA_FORMAT.md`). It runs outside the web server (cron or systemd timer) and only writes files.

- `write_cycle.py`  reference writer of the data format (uint16 with scale and offset, colour ranges, index update)
- `make_example.py` example cycles from old predictions (nl test set, ERA5-driven) for developing the app
