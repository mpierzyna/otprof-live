"""Paths of the pipelines (forecast and climatology), from environment variables with local defaults.

    pipeline/data/                OTPROF_DATA: data root of both pipelines (git-ignored)
      forecast/<cycle>/, running  OTPROF_FORECAST_DATA: one run directory per GFS cycle (forecast pipeline)
      climatology/                OTPROF_CLIM_DATA: ERA5 GRIB and zarr, predictions, statistics (climatology pipeline)
      webui/                      OTPROF_WEBUI_DATA: the web app's data root (docs/DATA_FORMAT.md), see upload.sh

The variables come from the environment or from `pipeline/.env` (KEY=value lines; the environment wins). Relative paths
are relative to `pipeline/`. Print a path for shell scripts: `uv run python -m otprof_live.config webui`.
"""

import logging
import os
import pathlib
import sys

logger = logging.getLogger("otprof-live")

PIPELINE_ROOT = pathlib.Path(__file__).resolve().parents[2]  # pipeline/ (src/otprof_live/config.py)
ENV_FILE = PIPELINE_ROOT / ".env"


def read_env_file(path: pathlib.Path) -> dict[str, str]:
    """KEY=value lines of `path` (comments, blank lines and quotes around values allowed); {} if it does not exist."""
    if not path.exists():
        return {}
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip("\"'")
    return env


_ENV = {**read_env_file(ENV_FILE), **os.environ}


def get_path(var: str, default: pathlib.Path) -> pathlib.Path:
    """Path of `var` (relative to `PIPELINE_ROOT`) or `default`."""
    value = _ENV.get(var)
    return (PIPELINE_ROOT / os.path.expanduser(value)).resolve() if value else default


DATA_ROOT = get_path("OTPROF_DATA", PIPELINE_ROOT / "data")
FORECAST_DATA = get_path("OTPROF_FORECAST_DATA", DATA_ROOT / "forecast")
CLIM_DATA = get_path("OTPROF_CLIM_DATA", DATA_ROOT / "climatology")
WEBUI_DATA = get_path("OTPROF_WEBUI_DATA", DATA_ROOT / "webui")

PATHS = {"data": DATA_ROOT, "forecast": FORECAST_DATA, "climatology": CLIM_DATA, "webui": WEBUI_DATA}


def setup_logging(level: int = logging.INFO):
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in PATHS:
        for name, path in PATHS.items():
            print(f"{name:12s} {path}")
    else:
        print(PATHS[sys.argv[1]])
