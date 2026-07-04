/**
 * Telemetry barrel (§9 observability) — the rest of the app imports from here.
 */
export { SqliteSpanExporter } from './exporter'
export { createTelemetry, type Telemetry, type WithSpanOptions } from './tracer'
