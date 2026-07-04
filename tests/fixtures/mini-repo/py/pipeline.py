from dataclasses import dataclass
from typing import TypedDict

from .filters import smooth


class SensorReading(TypedDict):
    zone: str
    moisture: float


@dataclass
class Batch:
    readings: list


def run_pipeline(readings):
    """Smooth raw sensor readings and batch them for the schedule engine."""
    cleaned = smooth([r["moisture"] for r in readings])
    return Batch(readings=cleaned)


def _internal_helper():
    return None
