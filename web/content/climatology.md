## Climatology

Twenty years of ERA5 pressure level data (2005--2025, 0.25°, 3-hourly) are post-processed with OTProf. 
The $C_n^2$ profiles are aggregated per calendar month and per grid cell.
The derived parameters ($r_0$ and $\sigma_I^2$) are first estimated at full 3h resolution and then aggregated per grid cell.

The switch next to the month selects the hours of the statistics: *Global* uses all hours, *Day* only the 12 UTC and *Night* only the 00 UTC time steps. The diurnal cycle always shows all hours.

The climatology of the whole domain can be downloaded as NetCDF, in two files. *Monthly statistics* has all statistics per calendar month and period (global, day, night), *Diurnal cycle* the main statistics per calendar month and hour (UTC). Both contain $\log_{10} C_n^2$ (`lcn2`), $C_n^2$ (`cn2`), $r_0$ and $\sigma_I^2$ (`si2`).

The profile on screen can be downloaded as a CSV file, for the month, grid cell and period selected. Each row is a height (`z_agl_m`), with the statistics shown here in $\log_{10} C_n^2$ (`lcn2_<stat>`, to 0.01) and in $C_n^2$ (`cn2_<stat>`, in m$^{-2/3}$). `cn2_mean` is the mean of the linear values, `cn2_gmean` the geometric mean.

