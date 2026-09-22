import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
const manifest = JSON.parse(open(__ENV.MANIFEST));
const names = __ENV.FOCUS === 'search' ? ['search', 'search_page'] : Object.keys(manifest);
const metrics = {};
const thresholds = { dropped_iterations: ['count==0'] };
for (const name of names) {
  metrics[name] = {
    latency: new Trend(`latency_${name}`, true), successLatency: new Trend(`success_latency_${name}`, true),
    count: new Counter(`requests_${name}`), ok: new Counter(`success_${name}`), failed: new Counter(`failed_${name}`),
  };
  thresholds[`latency_${name}`] = ['p(95)<500'];
}
export const options = {
  scenarios: { load: {
    executor: 'constant-arrival-rate', rate: Number(__ENV.RATE), timeUnit: '1s',
    duration: `${__ENV.DURATION}s`, preAllocatedVUs: 100, maxVUs: 500, gracefulStop: '15s',
  } },
  thresholds, summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max', 'avg'],
};
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
export default function () {
  const i = exec.scenario.iterationInTest;
  const slot = i % 40;
  const name = __ENV.FOCUS === 'search' ? names[i % 2]
    : slot < 6 ? 'search' : slot < 12 ? 'search_page' : slot < 20 ? 'catalog'
      : slot < 28 ? 'detail' : slot < 34 ? 'social' : slot < 37 ? 'recent' : 'popular';
  const pool = manifest[name];
  const item = pool[(Math.floor(i / 40) + slot) % pool.length];
  const result = http.get(`${__ENV.BASE_URL}${item.path}`, { timeout: '10s', tags: { name } });
  const m = metrics[name];
  m.count.add(1);
  m.latency.add(result.timings.duration);
  const valid = result.status === 200 && hash(result.body) === item.hash;
  m.ok.add(valid ? 1 : 0);
  m.failed.add(valid ? 0 : 1);
  if (valid) m.successLatency.add(result.timings.duration);
}
export function handleSummary(data) { return { [__ENV.SUMMARY]: JSON.stringify(data, null, 2) }; }
