## About

Live forecasts and climatology of optical turbulence profiles ($C_n^2$) and column-integrated
parameters (Fried parameter $r_0$ and scintillation index $\sigma_I^2$) over the Netherlands
produced by the deep learning model OTProf.

OTProf takes pressure level data from GFS (forecast) or ERA5 (climatology) as input and estimates $C_n^2$ profiles from it.
The $C_n^2$ profiles for training are produced by the Weather Research and Forecasting (WRF) model.

For more details, please check:

- [Pierzyna, Basu, Saathof (2026, preprint)](https://arxiv.org/abs/2604.09346): Methodology description and performance discussion.
- [OTProf](https://github.com/mpierzyna/otprof): Python code to run and train deep learning model.
- [OTProf WRF](https://github.com/mpierzyna/otprof-wrf): WRF setup to generate $C_n^2$ training dataset.
- [OTProf live](https://github.com/mpierzyna/otprof-live): GFS pipeline, climatology pipeline, this web UI.

**All data on this website is licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) which excludes any warranty.**

Copyright: Maximilian Pierzyna (2026)
