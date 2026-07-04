from fastapi import FastAPI

from . import run_pipeline

app = FastAPI()


@app.get("/readings")
def list_readings(readings=()):
    """Serve the smoothed sensor readings batch."""
    return run_pipeline(list(readings))
