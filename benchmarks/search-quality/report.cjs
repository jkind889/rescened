const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CATEGORIES } = require('./corpus.cjs');

const SCHEMA_VERSION = 1;
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function identity(data) {
  return { version: data.version, fixtureSha256: hash(data.albums), querySha256: hash(data.queries) };
}
function firstRank(ids, targets) {
  const index = ids.findIndex(value => targets.includes(value));
  return index < 0 ? null : index + 1;
}
function score(q, ids, page = false) {
  const positive = q.relevantIds.length > 0;
  const rank = firstRank(ids.slice(0, 5), q.relevantIds);
  const preferredRank = firstRank(ids, q.preferredIds);
  return {
    hitAt5: positive ? Number(rank !== null) : null,
    mrrAt5: positive ? (rank === null ? 0 : 1 / rank) : null,
    ...(page ? { recallAt24: positive ? ids.slice(0, 24).filter(value => q.relevantIds.includes(value)).length / q.relevantIds.length : null } : {}),
    correctlyEmpty: positive ? null : Number(ids.length === 0),
    preferredRank,
    preferredAt1: q.preferredIds.length ? Number(preferredRank === 1) : null,
  };
}
function evaluateQuery(q, autocompleteIds, pageIds, fullResultIds) {
  return {
    ...q,
    autocomplete: { ids: autocompleteIds, metrics: score(q, autocompleteIds) },
    page: { ids: pageIds, metrics: score(q, pageIds, true) },
    fullResultIds,
    diagnostics: {
      notRetrievedIds: q.relevantIds.filter(value => !fullResultIds.includes(value)),
      belowTop5Ids: q.relevantIds.filter(value => fullResultIds.includes(value) && !autocompleteIds.includes(value)),
      beyondFirstPageIds: q.relevantIds.filter(value => fullResultIds.includes(value) && !pageIds.includes(value)),
      unmetPreference: q.preferredIds.length > 0 && !q.preferredIds.includes(pageIds[0]),
      // A 30-album discography cannot have recall@24 of 1, even with perfect ordering.
      recallAt24Ceiling: q.relevantIds.length ? Math.min(24, q.relevantIds.length) / q.relevantIds.length : null,
    },
  };
}
function average(values) {
  const applicable = values.filter(value => value !== null);
  return applicable.length ? applicable.reduce((a, b) => a + b, 0) / applicable.length : null;
}
function aggregate(cases) {
  const result = { count: cases.length, positiveCount: cases.filter(q => q.relevantIds.length).length };
  for (const surface of ['autocomplete', 'page']) {
    result[surface] = Object.fromEntries(['hitAt5', 'mrrAt5', ...(surface === 'page' ? ['recallAt24'] : []), 'correctlyEmpty', 'preferredAt1']
      .map(metric => [metric, average(cases.map(q => q[surface].metrics[metric]))]));
  }
  return result;
}
function summarize(cases) {
  return { overall: aggregate(cases), categories: Object.fromEntries(CATEGORIES.map(category => [category, aggregate(cases.filter(q => q.category === category))])) };
}
function makeReport(data, cases, environment) {
  assert.equal(cases.length, data.queries.length, 'Incomplete evaluation');
  return {
    schemaVersion: SCHEMA_VERSION, status: 'complete', corpus: identity(data), environment,
    catalog: data.albums.map(({ albumId, title, artistDisplayName }) => ({ albumId, title, artistDisplayName })),
    cases, summary: summarize(cases),
  };
}
function validateReport(report) {
  assert.equal(report.schemaVersion, SCHEMA_VERSION, 'Unsupported report schema');
  assert.equal(report.status, 'complete', 'Cannot compare incomplete reports');
  assert.equal(typeof report.corpus?.version, 'string');
  for (const key of ['fixtureSha256', 'querySha256']) assert.match(report.corpus[key], /^[a-f0-9]{64}$/);
  assert.equal(report.cases?.length, 30, 'Incomplete report cases');
  assert.equal(new Set(report.cases.map(q => q.id)).size, 30, 'Duplicate report cases');
  const albums = new Set(report.catalog.map(a => a.albumId));
  for (const q of report.cases) {
    assert.ok(CATEGORIES.includes(q.category), 'Invalid report category');
    assert.equal(q.relevantIds.length === 0, q.category === 'miss');
    for (const ids of [q.relevantIds, q.preferredIds, q.autocomplete.ids, q.page.ids, q.fullResultIds]) {
      assert.ok(Array.isArray(ids) && ids.every(value => albums.has(value)), 'Unknown report album');
      assert.equal(new Set(ids).size, ids.length, 'Duplicate report result');
    }
    assert.deepEqual(q.autocomplete.ids, q.fullResultIds.slice(0, 5), 'Inconsistent autocomplete results');
    assert.deepEqual(q.page.ids, q.fullResultIds.slice(0, 24), 'Inconsistent first page');
    const recomputed = evaluateQuery(q, q.autocomplete.ids, q.page.ids, q.fullResultIds);
    assert.deepEqual(q.autocomplete.metrics, recomputed.autocomplete.metrics, 'Invalid report metrics');
    assert.deepEqual(q.page.metrics, recomputed.page.metrics, 'Invalid report metrics');
    assert.deepEqual(q.diagnostics, recomputed.diagnostics, 'Invalid report diagnostics');
  }
  const judgments = report.cases.map(({ id, category, query, intent, explanation, relevantIds, preferredIds }) => ({ id, category, query, intent, explanation, relevantIds, preferredIds }));
  assert.equal(hash(judgments), report.corpus.querySha256, 'Report judgments do not match their checksum');
  assert.deepEqual(report.summary, summarize(report.cases), 'Invalid report summary');
}
function assertCompatible(before, corpusIdentity) {
  validateReport(before);
  assert.deepEqual(before.corpus, corpusIdentity, 'Incompatible corpus version or checksums');
}
function delta(before, after) { return before === null || after === null ? null : after - before; }
function metricChanges(before, after) {
  return Object.fromEntries(['autocomplete', 'page'].map(surface => [surface,
    Object.fromEntries(Object.keys(after[surface]).map(key => [key, delta(before[surface][key], after[surface][key])])),
  ]));
}
function compare(before, after) {
  assertCompatible(before, after.corpus);
  validateReport(after);
  const oldCases = new Map(before.cases.map(q => [q.id, q]));
  return {
    overall: metricChanges(before.summary.overall, after.summary.overall),
    categories: Object.fromEntries(CATEGORIES.map(category => [category, metricChanges(before.summary.categories[category], after.summary.categories[category])])),
    cases: after.cases.map(q => {
      const old = oldCases.get(q.id);
      assert.ok(old, 'Missing comparison query');
      return { id: q.id,
        metrics: metricChanges({ autocomplete: old.autocomplete.metrics, page: old.page.metrics }, { autocomplete: q.autocomplete.metrics, page: q.page.metrics }),
        resultOrderChanged: hash([old.autocomplete.ids, old.fullResultIds]) !== hash([q.autocomplete.ids, q.fullResultIds]),
        newlyRetrievedIds: old.diagnostics.notRetrievedIds.filter(value => !q.diagnostics.notRetrievedIds.includes(value)),
        newlyMissingIds: q.diagnostics.notRetrievedIds.filter(value => !old.diagnostics.notRetrievedIds.includes(value)),
      };
    }),
  };
}
function escape(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/[\r\n]/g, ' '); }
const number = value => value === null ? '—' : value.toFixed(3);
function markdown(report) {
  const labels = new Map(report.catalog.map(a => [a.albumId, `${escape(a.artistDisplayName)} — ${escape(a.title)} (${a.albumId})`]));
  const names = ids => ids.length ? ids.map(value => labels.get(value)).join('; ') : 'None';
  const ranks = ids => ids.length ? ids.map((value, n) => `${n + 1}. ${labels.get(value)}`).join('; ') : 'None';
  const lines = ['# Search quality baseline', '',
    'Synthetic behavior coverage, not production catalog coverage or a performance measurement. Quality gaps are diagnostic.', '',
    `Corpus version: ${report.corpus.version}; fixture SHA-256: ${report.corpus.fixtureSha256}; query SHA-256: ${report.corpus.querySha256}.`, '',
    `Git: ${report.environment.revision} (dirty: ${report.environment.dirty}). Node: ${report.environment.node}; MongoDB: ${report.environment.mongo}.`, '',
    'Hit@5 and MRR@5 average only positive queries. Recall@24 uses all relevant fixture albums as the denominator. Empty accuracy averages only expected misses. Preferred@1 accepts any member of the preferred set. — means not applicable.', '',
    '| Category | Cases | Autocomplete Hit@5 | Autocomplete MRR@5 | Page Hit@5 | Page MRR@5 | Page Recall@24 | Empty accuracy (auto/page) | Preferred@1 (auto/page) |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |'];
  for (const [name, summary] of [['overall', report.summary.overall], ...Object.entries(report.summary.categories)]) {
    const a = summary.autocomplete; const p = summary.page;
    lines.push(`| ${name} | ${summary.count} | ${number(a.hitAt5)} | ${number(a.mrrAt5)} | ${number(p.hitAt5)} | ${number(p.mrrAt5)} | ${number(p.recallAt24)} | ${number(a.correctlyEmpty)} / ${number(p.correctlyEmpty)} | ${number(a.preferredAt1)} / ${number(p.preferredAt1)} |`);
  }
  if (report.comparison) {
    lines.push('', '## Change from comparison report', '', 'Deltas are current minus previous; higher quality scores are better. Preferred-rank deltas are better when negative.', '',
      `Overall deltas: ${JSON.stringify(report.comparison.overall)}`, '',
      '| Query | Autocomplete Δ Hit / MRR | Page Δ Hit / MRR / Recall | Order changed |', '| --- | --- | --- | --- |');
    for (const change of report.comparison.cases) {
      const a = change.metrics.autocomplete; const p = change.metrics.page;
      lines.push(`| ${change.id} | ${number(a.hitAt5)} / ${number(a.mrrAt5)} | ${number(p.hitAt5)} / ${number(p.mrrAt5)} / ${number(p.recallAt24)} | ${change.resultOrderChanged} |`);
    }
  }
  for (const q of report.cases) {
    lines.push('', `## ${q.id}: ${escape(JSON.stringify(q.query))}`, '',
      `${escape(q.intent)}. ${escape(q.explanation)}`, '',
      `Expected relevant: ${names(q.relevantIds)}`, '', `Preferred at rank 1 (any): ${names(q.preferredIds)}`, '',
      `Autocomplete, ranked: ${ranks(q.autocomplete.ids)}`, '', `First page, ranked: ${ranks(q.page.ids)}`, '',
      `Not retrieved on any page: ${names(q.diagnostics.notRetrievedIds)}`, '',
      `Matched but below top 5: ${names(q.diagnostics.belowTop5Ids)}`, '',
      `Matched but beyond first page: ${names(q.diagnostics.beyondFirstPageIds)}`, '',
      `Preferred rank (autocomplete/page): ${q.autocomplete.metrics.preferredRank ?? '—'} / ${q.page.metrics.preferredRank ?? '—'}; unmet preference: ${q.diagnostics.unmetPreference}. Recall@24 ceiling: ${number(q.diagnostics.recallAt24Ceiling)}.`, '',
      `Scores: autocomplete ${JSON.stringify(q.autocomplete.metrics)}; page ${JSON.stringify(q.page.metrics)}.`);
  }
  return `${lines.join('\n')}\n`;
}
module.exports = { SCHEMA_VERSION, hash, identity, score, evaluateQuery, summarize, makeReport, validateReport, assertCompatible, compare, markdown };
