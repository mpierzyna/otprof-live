"""Waiting for a GFS cycle on AWS in Airflow: `GfsCycleTrigger` polls `otprof.sources.gfs.is_cycle_available` in the
triggerer, `WaitForGfsCycle` defers to it, so no worker slot is taken while waiting (a run takes about 3.5-5 h to be
uploaded). Lives in the plugins folder, which is importable by the scheduler, the workers and the triggerer.
"""

from __future__ import annotations

import asyncio
import datetime

import pandas as pd
from airflow.sdk import BaseOperator
from airflow.triggers.base import BaseTrigger, TriggerEvent
from otprof.sources import gfs


class GfsCycleTrigger(BaseTrigger):
    """Fires once the GFS run `cycle` (ISO time) is on AWS up to lead time `last_lead` [h]; checks every
    `poll_interval` seconds."""

    def __init__(self, cycle: str, last_lead: int, poll_interval: float = 300):
        super().__init__()
        self.cycle = cycle
        self.last_lead = last_lead
        self.poll_interval = poll_interval

    def serialize(self):
        return (
            f"{__name__}.GfsCycleTrigger",
            {"cycle": self.cycle, "last_lead": self.last_lead, "poll_interval": self.poll_interval},
        )

    async def run(self):
        while not await asyncio.to_thread(gfs.is_cycle_available, self.cycle, self.last_lead):
            self.log.info(f"GFS cycle {self.cycle} not on AWS yet up to lead {self.last_lead} h")
            await asyncio.sleep(self.poll_interval)
        yield TriggerEvent({"cycle": self.cycle})


class WaitForGfsCycle(BaseOperator):
    """Waits (deferred) until the GFS run of the DAG run is on AWS up to `last_lead` and returns its cycle (ISO time,
    as XCom). The cycle is the run's logical date (schedule on the cycle times), for runs without one (manual) the
    current cycle. Fails after `timeout`."""

    def __init__(
        self,
        last_lead: int,
        poll_interval: float = 300,
        timeout: datetime.timedelta = datetime.timedelta(hours=12),
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.last_lead = last_lead
        self.poll_interval = poll_interval
        self.wait_timeout = timeout

    def execute(self, context):
        date = context.get("logical_date") or pd.Timestamp.now("UTC")
        cycle = pd.Timestamp(date).tz_convert("UTC").tz_localize(None).floor("6h")
        if gfs.is_cycle_available(cycle, self.last_lead):
            return cycle.isoformat()
        self.log.info(f"Waiting for GFS cycle {cycle} up to lead {self.last_lead} h")
        self.defer(
            trigger=GfsCycleTrigger(cycle.isoformat(), self.last_lead, self.poll_interval),
            method_name="execute_complete",
            timeout=self.wait_timeout,
        )

    def execute_complete(self, context, event):
        return event["cycle"]
