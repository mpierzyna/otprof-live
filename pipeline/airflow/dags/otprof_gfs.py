import pathlib

from airflow.providers.standard.operators.bash import BashOperator

from airflow.sdk import DAG

HERE = pathlib.Path(__file__).parent
CODE_ROOT = HERE.parent.parent

with DAG("otprof_gfs") as dag:
    step_0 = BashOperator(
        task_id="prepare",
        bash_command=f"cd {CODE_ROOT} && uv run step_0_prepare.py",
    )

    step_1 = BashOperator(
        task_id="download_gfs",
        bash_command=f"cd {CODE_ROOT} && uv run step_1_download_gfs.py",
    )

    step_2 = BashOperator(
        task_id="predict",
        bash_command=f"cd {CODE_ROOT} && uv run step_2_predict.py",
    )

    step_3 = BashOperator(
        task_id="convert",
        bash_command=f"cd {CODE_ROOT} && uv run step_3_convert.py",
    )

    step_4 = BashOperator(
        task_id="upload",
        bash_command=f"cd {CODE_ROOT} && bash step_4_upload.sh",
    )

    step_0 >> step_1 >> step_2 >> step_3 >> step_4
