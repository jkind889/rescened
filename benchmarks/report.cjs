const fs = require('node:fs');
const crypto = require('node:crypto');
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function summarize(summary, names, duration, exitCode = 0) {
  const elapsedSeconds = summary.state?.testRunDurationMs / 1000 || duration;
  const metric = (name) => summary.metrics?.[name]?.values || {};
  const endpoints = {};
  for (const name of names) {
    const requests = metric(`requests_${name}`).count || 0;
    const success = metric(`success_${name}`).count || 0;
    const latency = metric(`latency_${name}`);
    endpoints[name] = {
      requests, success, errors: requests - success,
      successfulRps: success / elapsedSeconds, errorRate: requests ? (requests - success) / requests : null,
      p50: latency.med ?? null, p95: latency['p(95)'] ?? null, p99: latency['p(99)'] ?? null,
      successfulP95: metric(`success_latency_${name}`)['p(95)'] ?? null,
    };
  }
  const dropped = metric('dropped_iterations').count || 0;
  const requests = Object.values(endpoints).reduce((sum, row) => sum + row.requests, 0);
  const success = Object.values(endpoints).reduce((sum, row) => sum + row.success, 0);
  return {
    endpoints, dropped, requests, success, elapsedSeconds, successfulRps: success / elapsedSeconds,
    errorRate: requests ? (requests - success) / requests : null,
    qualified: exitCode === 0 && dropped === 0 && requests > 0 && (requests - success) / requests < 0.01
      && Object.values(endpoints).every((row) => row.requests > 0 && row.p95 !== null && row.p95 < 500 && row.errorRate < 0.01),
  };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function compare(report) {
  const groups = {};
  for (const run of report.runs.filter((r) => r.phase === 'confirm')) {
    const key = `${run.dataset}:${run.focus}:${run.rate}:${run.duration}`;
    (groups[key] ||= { baseline: [], current: [] })[run.variant].push(run);
  }
  const comparisons = [];
  for (const [key, group] of Object.entries(groups)) {
    if (group.baseline.length !== 3 || group.current.length !== 3) continue;
    if (new Set([...group.baseline, ...group.current].map((r) => r.compatibility)).size !== 1) throw new Error('Incompatible benchmark runs');
    for (const name of Object.keys(group.baseline[0].metrics.endpoints)) {
      const before = group.baseline.map((r) => r.metrics.endpoints[name].p95);
      const after = group.current.map((r) => r.metrics.endpoints[name].p95);
      if ([...before, ...after].some((n) => !Number.isFinite(n))) continue;
      const healthy = [...group.baseline, ...group.current].every((r) =>
        r.metrics.dropped === 0 && r.metrics.endpoints[name].errorRate === 0 && [0, 99].includes(r.exitCode));
      comparisons.push({
        key, endpoint: name, baselineP95: median(before), currentP95: median(after),
        baselineRange: [Math.min(...before), Math.max(...before)], currentRange: [Math.min(...after), Math.max(...after)],
        improvementPercent: 100 * (median(before) - median(after)) / median(before),
        repeatable: healthy && Math.max(...after) < Math.min(...before), healthy,
      });
    }
  }
  return comparisons;
}
function markdown(report) {
  const comparisons = compare(report);
  const lines = [
    '# Rescened local benchmark report', '',
    'Synthetic local application/database capacity. Clerk, admission rate limits, TLS, and network hosting are excluded. API, MongoDB, and k6 share one machine.', '',
    `Status: ${report.status}. Revision: ${report.environment.revision}. Dirty worktree: ${report.environment.dirty}.`,
    `Machine: ${report.environment.cpu}; ${report.environment.cpus} logical CPUs; ${report.environment.memoryGiB} GiB RAM.`,
    `Node ${report.environment.node}; ${report.environment.k6}.`, '',
    'Durations exclude separate warmup. Rates are requests per second, not real users.', '',
    '| Dataset | Variant | Phase | Workload | Offered RPS | Seconds | Successful RPS | Errors | Dropped | Qualified |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const r of report.runs) lines.push(`| ${r.dataset} | ${r.variant} | ${r.phase} | ${r.focus} | ${r.rate} | ${r.duration} | ${r.metrics.successfulRps.toFixed(2)} | ${r.metrics.requests - r.metrics.success} | ${r.metrics.dropped} | ${r.metrics.qualified} |`);
  lines.push('', '## Paired p95 comparisons', '', '| Workload | Endpoint | Baseline median (range), ms | Current median (range), ms | Improvement | Repeatable |', '| --- | --- | --- | --- | ---: | --- |');
  const f = (n) => n.toFixed(2);
  for (const c of comparisons) lines.push(`| ${c.key} | ${c.endpoint} | ${f(c.baselineP95)} (${c.baselineRange.map(f).join('–')}) | ${f(c.currentP95)} (${c.currentRange.map(f).join('–')}) | ${f(c.improvementPercent)}% | ${c.repeatable} |`);
  if (!comparisons.length) lines.push('', 'No complete set of three paired confirmation runs yet; no resume improvement claim is supported.');
  lines.push('', '## Resume evidence', '');
  const best = comparisons.filter((c) => c.repeatable && c.key.startsWith('main:') && c.key.endsWith(':300') && c.endpoint.startsWith('search')).sort((a, b) => b.improvementPercent - a.improvementPercent)[0];
  if (best) lines.push(`Reduced ${best.endpoint === 'search_page' ? 'paginated ' : ''}catalog-search p95 latency by ${Math.floor(best.improvementPercent)}% on a 50,000-album synthetic dataset, verified through three paired five-minute local load tests at ${best.key.split(':')[2]} requests/second.`);
  else lines.push('Search improvement claim pending repeatable, error-free main-dataset measurements.');
  const rates = report.runs.filter((r) => r.phase === 'confirm' && r.focus === 'mixed' && r.variant === 'current' && r.dataset === 'main' && r.duration === 300);
  if (rates.length === 3 && rates.every((r) => r.metrics.qualified)) lines.push('', `Load-tested an Express/MongoDB music catalog with 50,000 synthetic albums and 500,000 reviews at ${rates[0].rate} requests/second, sustaining sub-500 ms p95 on every tested endpoint across three five-minute local runs.`);
  else lines.push('', 'Capacity resume claim pending three qualifying five-minute main-dataset mixed-workload runs.');
  return `${lines.join('\n')}\n`;
}
if (require.main === module) process.stdout.write(markdown(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
module.exports = { digest, summarize, median, compare, markdown };
