/**
 * Dependency-free Prometheus-style metrics.
 * The API exposes them at GET /metrics; swap for prom-client if label
 * cardinality or histograms become necessary.
 */
const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const startedAt = Date.now();

function normalise(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

export function incrementMetric(name: string, by = 1): void {
  const key = normalise(name);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function setGauge(name: string, value: number): void {
  gauges.set(normalise(name), value);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  lines.push('# HELP glamconnect_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE glamconnect_uptime_seconds gauge');
  lines.push(`glamconnect_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  lines.push('# HELP glamconnect_process_resident_memory_bytes Resident memory');
  lines.push('# TYPE glamconnect_process_resident_memory_bytes gauge');
  lines.push(`glamconnect_process_resident_memory_bytes ${process.memoryUsage().rss}`);
  for (const [key, value] of counters) {
    lines.push(`# TYPE ${key} counter`);
    lines.push(`${key} ${value}`);
  }
  for (const [key, value] of gauges) {
    lines.push(`# TYPE ${key} gauge`);
    lines.push(`${key} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
}
