# Sprout panel

Sprout is a greenhouse control panel that computes watering schedules from
sensor readings and serves them over a small HTTP API.

## Layout

TypeScript modules under `src` hold the schedule engine and the HTTP routes;
the Python package under `py` runs the sensor reading pipeline that feeds it.
