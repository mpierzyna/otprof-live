import pathlib
import logging

logger = logging.getLogger("otprof-live")

HERE = pathlib.Path(__file__).parent
DATA_ROOT = HERE / "data"
RUNNING_DIR = DATA_ROOT / "running"
