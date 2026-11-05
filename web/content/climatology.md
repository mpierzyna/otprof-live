## Climatology

Twenty years of ERA5 pressure level data (2005--2025, 0.25°, 3-hourly) are post-processed with OTProf. 
The $C_n^2$ profiles are aggregated per calendar month and per grid cell.
The derived parameters ($r_0$ and $\sigma_I^2$) are first estimated at full 3h resolution and then aggregated per grid cell.

The switch next to the month selects the hours of the statistics: *Global* uses all hours, *Day* and *Night* only the time step nearest to 12:00 and 00:00 local time. Local time is UTC+1 all year (no daylight saving), as it follows the sun; with 3-hourly data these are 13:00 and 01:00 UTC+1 (12 and 00 UTC). The diurnal cycle always shows all hours.

The $C_n^2$ profiles of a month and grid cell can be downloaded as a ZIP of three CSV files (global, day, night). Each row is a height (`z_agl_m`), with the number of time steps (`n`), all statistics of the linear $C_n^2$ (`cn2_<stat>`, in m$^{-2/3}$) and the mean and standard deviation of $\log_{10} C_n^2$ (`lcn2_mean`, `lcn2_std`).

