import datetime
import pathlib

from airflow.providers.standard.operators.bash import BashOperator
from airflow.sdk import DAG
from gfs_cycle import WaitForGfsCycle  # airflow/plugins

HERE = pathlib.Path(__file__).parent
CODE_ROOT = HERE.parent.parent

# One run per GFS cycle, created at the cycle time: `wait_for_gfs` waits (deferred, in the triggerer) until the cycle is
# on AWS, then the steps run with that cycle. One run at a time, as all share `data/running`.
with DAG(
    "otprof_gfs",
    schedule="0 */6 * * *",
    start_date=datetime.datetime(2026, 10, 1, tzinfo=datetime.UTC),
    catchup=False,
    max_active_runs=1,
) as dag:
    wait = WaitForGfsCycle(
        task_id="wait_for_gfs",
        last_lead=120,  # shared.LEADS[-1]
        poll_interval=300,
        timeout=datetime.timedelta(hours=12),
    )

    step_0 = BashOperator(
        task_id="00_prepare",
        bash_command=f"cd {CODE_ROOT} && uv run step_0_prepare.py --cycle {{{{ ti.xcom_pull(task_ids='wait_for_gfs') }}}}",
        skip_on_exit_code=99,  # shared.EXIT_NOTHING_NEW: cycle processed already
    )

    step_1 = BashOperator(
        task_id="01_download_gfs",
        bash_command=f"cd {CODE_ROOT} && uv run step_1_download_gfs.py",
    )

    step_2 = BashOperator(
        task_id="02_predict",
        bash_command=f"cd {CODE_ROOT} && uv run step_2_predict.py",
    )

    step_3 = BashOperator(
        task_id="03_convert",
        bash_command=f"cd {CODE_ROOT} && uv run step_3_convert.py",
    )

    step_4 = BashOperator(
        task_id="04_upload",
        bash_command=f"cd {CODE_ROOT} && bash step_4_upload.sh",
    )

    wait >> step_0 >> step_1 >> step_2 >> step_3 >> step_4
