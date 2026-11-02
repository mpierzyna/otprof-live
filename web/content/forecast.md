## GFS-based forecasts
Forecasts are produced by postprocessing the output of the [Global Forecast System (GFS)](https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast) with OTProf.
GFS forecasts are available live and for free. 
A new GFS forecast is produced four times a day (00 UTC, 06 UTC, 12 UTC, 18 UTC), with 16 days lead time.
Here, we utilize only the first five forecast days (120 hours).
The website updates automatically whenever a new GFS run becomes available, and the `Forecast run` selector allows switching between them.

Note, GFS's shape is compatible with the ERA5 pressure level training data (0.25 degree, 30+ pressure levels), but **we did not perform a GFS-specific performance analysis**.
GFS is produced by a different numerical weather model with different errors and biases.
We expect qualitative performance to be acceptable, but do not give any warranty.
