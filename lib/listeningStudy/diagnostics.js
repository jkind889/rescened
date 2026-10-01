// Post-hoc diagnostic experiment. Never changes the frozen evaluator or its artifacts.
const fs = require('node:fs');
const { hash, text, normalizeAlbum, compareAlbum } = require('./core');
const { assertStudy, editionsOf, report } = require('./study');
const { applyReviewedAliases, manifest: aliasManifest } = require('./reviewedAliases');
const VERSION = 'matching-diagnostics-1.2.0';

// Only typographic hyphens, not arbitrary punctuation or version qualifiers.
const typography = (value) => text(value).replace(/[\u2010\u2011]/g, '-');
const guests = (value) => typography(value).split(/\s+(?:&|and)\s+/u).filter(Boolean).sort();
function credit(value) {
  const cleaned = typography(value);
  const match = cleaned.match(/^(.*?)\s*(?:\[|\()?\s*\b(?:feat\.?|featuring)\s+(.+?)(?:\]|\))?$/u);
  return match ? { main: match[1].trim(), guests: guests(match[2]) } : { main: cleaned, guests: [] };
}
function canonicalTrack(track) {
  const artist = credit(track.artist);
  const titleGuests = [];
  const title = typography(track.title).replace(/[([](?:feat\.?|featuring)\s+([^\])]+)[\])]/gu, (_, names) => {
    titleGuests.push(...guests(names)); return '';
  }).replace(/\s+/gu, ' ').trim();
  const unique = (values) => [...new Set(values)].sort();
  const fromArtist = unique(artist.guests); const fromTitle = unique(titleGuests);
  // Conflicting populated credits are unresolved, never unioned into a guessed identity.
  const conflict = fromArtist.length > 0 && fromTitle.length > 0 && JSON.stringify(fromArtist) !== JSON.stringify(fromTitle);
  const featured = fromArtist.length ? fromArtist : fromTitle;
  return { title, artist: artist.main, guests: featured, conflict,
    key: conflict ? null : JSON.stringify([title, artist.main, featured]) };
}
// Coverage is order-independent, but only unique one-to-one identities count.
// Repeated titles cannot stand in for multiple distinct positions.
function trackCoverage(expected, actual) {
  const index = (tracks) => {
    const map = new Map();
    tracks.forEach((track, i) => {
      if (track.key === null) return;
      if (!map.has(track.key)) map.set(track.key, []);
      map.get(track.key).push(i + 1);
    });
    return map;
  };
  const left = index(expected); const right = index(actual);
  const matches = [];
  for (const [key, positions] of left) {
    if (positions.length === 1 && right.get(key)?.length === 1) {
      matches.push({ referencePosition: positions[0], returnedPosition: right.get(key)[0] });
    }
  }
  const matched = matches.length;
  const required = Math.ceil(expected.length * 0.8);
  return { status: 'scored', matched, referenceTotal: expected.length, returnedTotal: actual.length,
    referencePercent: expected.length ? matched / expected.length * 100 : null,
    returnedPercent: actual.length ? matched / actual.length * 100 : null,
    requiredReferenceTracks: required,
    enoughReferenceTracksFor80Percent: expected.length > 0 && matched >= required,
    matches,
    unmatchedReferencePositions: expected.flatMap((_, i) => matches.some((m) => m.referencePosition === i + 1) ? [] : [i + 1]),
    unmatchedReturnedPositions: actual.flatMap((_, i) => matches.some((m) => m.returnedPosition === i + 1) ? [] : [i + 1]),
    ambiguousReferencePositions: [...left.values()].filter((positions) => positions.length > 1).flat(),
    ambiguousReturnedPositions: [...right.values()].filter((positions) => positions.length > 1).flat() };
}
function candidateComparison(reference, record) {
  const strict = compareAlbum(reference, record);
  const album = normalizeAlbum(record?.payload);
  if (!reference?.verified || record?.status !== 'ok' || album.status !== 'ok') {
    return { strict, candidate: { status: strict.status, correct: false }, differences: [], coverage: { status: strict.status, strict: null, candidate: null } };
  }
  const expected = reference.tracks.map(canonicalTrack); const actual = album.tracks.map(canonicalTrack);
  const valid = [...expected, ...actual].every((t) => t.key !== null);
  const keys = (tracks) => tracks.map((t) => t.key);
  const count = expected.length === actual.length;
  const membership = valid && JSON.stringify(keys(expected).sort()) === JSON.stringify(keys(actual).sort());
  const order = valid && JSON.stringify(keys(expected)) === JSON.stringify(keys(actual)) && album.tracks.every((t) => t.rankValid);
  const differences = Array.from({ length: Math.max(expected.length, actual.length) }, (_, i) => {
    const a = reference.tracks[i]; const b = album.tracks[i];
    if (a && b && text(a.title) === text(b.title) && text(a.artist) === text(b.artist) && b.rankValid) return null;
    return { position: i + 1, expected: a ? { title: a.title, artist: a.artist } : null,
      actual: b ? { title: b.title, artist: b.artist } : null,
      resolvedByFormatting: Boolean(expected[i]?.key && expected[i].key === actual[i]?.key && b?.rankValid) };
  }).filter(Boolean);
  return { strict, candidate: { status: 'scored', correct: count && membership && order && strict.identity,
    count, membership, order, identity: strict.identity, creditConflict: !valid }, differences,
    coverage: { status: 'scored',
      strict: trackCoverage(reference.tracks.map((t) => ({ key: JSON.stringify([text(t.title), text(t.artist)]) })),
        album.tracks.map((t) => ({ key: JSON.stringify([text(t.title), text(t.artist)]) }))),
      candidate: trackCoverage(expected, actual) } };
}
function duplicateTitles(tracks) {
  const positions = new Map();
  tracks.forEach((track, i) => {
    const key = JSON.stringify([text(track.title), text(track.artist)]);
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(i + 1);
  });
  return [...positions.values()].filter((list) => list.length > 1);
}
function buildDiagnostics(study) {
  const { sample } = assertStudy(study);
  const provenance = { diagnosticVersion: VERSION, diagnosticRulesHash: hash(fs.readFileSync(__filename, 'utf8')),
    aliasManifestHash: hash(aliasManifest), aliasCodeHash: hash(fs.readFileSync(require.resolve('./reviewedAliases'), 'utf8')),
    generatedAt: new Date().toISOString(), studySnapshotHash: hash(study), sampleHash: study.sampleHash,
    frozenRulesHash: study.rulesHash, referencesHash: hash(study.references), postHoc: true };
  const albums = editionsOf(sample).map((spec) => ({ id: spec.id, kind: spec.kind,
    referenceSource: study.references[spec.id]?.source || null,
    referenceFetchedAt: study.references[spec.id]?.fetchedAt || null,
    nameCapturedAt: study.albums[spec.id]?.name?.fetchedAt || null,
    mbidCapturedAt: study.albums[spec.id]?.mbid?.fetchedAt || null,
    name: candidateComparison(study.references[spec.id], study.albums[spec.id]?.name),
    mbid: candidateComparison(study.references[spec.id], study.albums[spec.id]?.mbid) }));
  for (const row of albums) for (const lookup of ['name', 'mbid']) {
    const aliases = applyReviewedAliases(row.id, study.references[row.id], study.albums[row.id]?.[lookup]);
    const revised = candidateComparison(study.references[row.id], aliases.record);
    row[lookup].reviewed = { comparison: revised.candidate, coverage: revised.coverage.candidate, applied: aliases.applied };
  }
  const summary = (lookup) => ({ total: albums.length, strictMatches: albums.filter((r) => r[lookup].strict.correct).length,
    reviewedAliasMatches: albums.filter((r) => r[lookup].reviewed.comparison.correct).length,
    newlyMatchedByAliases: albums.filter((r) => !r[lookup].candidate.correct && r[lookup].reviewed.comparison.correct).map((r) => r.id),
    reviewedAlias80PercentCoverage: albums.filter((r) => r[lookup].reviewed.coverage?.enoughReferenceTracksFor80Percent).length,
    candidateMatches: albums.filter((r) => r[lookup].candidate.correct).length,
    newlyMatched: albums.filter((r) => !r[lookup].strict.correct && r[lookup].candidate.correct).map((r) => r.id),
    unresolved: albums.filter((r) => !r[lookup].candidate.correct).length,
    coverageAvailable: albums.filter((r) => r[lookup].coverage.status === 'scored').length,
    atLeast80PercentReferenceCoverage: albums.filter((r) => r[lookup].coverage.candidate?.enoughReferenceTracksFor80Percent).length });
  const matching = { ...provenance, purpose: 'Reference-to-provider track matching; not proof of playback edition identity',
    rules: ['Normalize Unicode hyphen/nonbreaking hyphen to ASCII hyphen', 'Move explicit featured credits between track title and artist; require matching guests',
      'Normalize and/& only within featured-credit lists', 'Preserve live, remix, remaster, demo, acoustic, bonus and edition qualifiers', 'No fuzzy matching or unreviewed aliases'],
    name: summary('name'), mbid: summary('mbid'), albums };
  const baselines = editionsOf(sample).map((spec) => {
    const ref = study.references[spec.id]; const record = study.albums[spec.id]?.name;
    const album = normalizeAlbum(record?.payload); const comparison = albums.find((r) => r.id === spec.id).name;
    return { id: spec.id, referenceSource: ref?.source || null, expectedCount: ref?.tracks?.length ?? null,
      returnedCount: album.tracks?.length ?? null, expectedThreshold: ref?.tracks?.length ? Math.ceil(ref.tracks.length * 0.8) : null,
      returnedThreshold: album.tracks?.length ? Math.ceil(album.tracks.length * 0.8) : null,
      status: comparison.candidate.status, countMatches: comparison.candidate.count ?? false,
      candidateTracklistMatches: comparison.candidate.correct, returnedTitle: album.title || null, returnedMbid: album.mbid || null,
      duplicateTitlePositions: album.tracks ? duplicateTitles(album.tracks) : [],
      limitation: comparison.candidate.correct ? 'Reference comparison matches; playback identity unproven' : 'Tracklist missing or differences unresolved; inspect track-matching report' };
  });
  const pairs = sample.pairs.map((pair) => {
    const a = baselines.find((b) => b.id === `${pair.id}:standard`); const b = baselines.find((b) => b.id === `${pair.id}:deluxe`);
    const available = a.status === 'scored' && b.status === 'scored';
    return { id: pair.id, status: available ? 'observed' : 'incomplete',
      differentReturnedTitles: available ? text(a.returnedTitle) !== text(b.returnedTitle) : null,
      samePopulatedMbid: available ? Boolean(a.returnedMbid && a.returnedMbid === b.returnedMbid) : null,
      bothCandidateTracklistsMatch: a.candidateTracklistMatches && b.candidateTracklistMatches };
  });
  // Existing controlled-session scoring remains frozen. Revised track matching is not silently applied to playback.
  const frozen = report(study);
  const playback = { matcher: 'frozen study rules; diagnostic normalization not applied', total: frozen.controls.length,
    completed: frozen.controls.filter((c) => c.edition.status === 'scored').length,
    correctEditionSessions: frozen.edition.correctSessions, wrongEditionLogs: frozen.edition.wrongEditions,
    falsePositiveSessions: frozen.edition.falsePositives, correctStandardSessions: frozen.standard.correctSessions,
    standardFalsePositiveSessions: frozen.standard.falsePositives, sessions: frozen.controls };
  const identity = { ...provenance, purpose: 'Edition metadata and actual playback evidence, independent of formatting improvements',
    conclusion: playback.completed < playback.total ? 'actual_playback_incomplete' : 'review_controlled_results_against_frozen_pilot_report',
    baselines, pairs, playback };
  return { matching, identity };
}
const escape = (value) => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
function matchingMarkdown(result) {
  const lines = ['# Track-matching diagnostic report', '', `Post-hoc experiment ${result.diagnosticVersion}. Frozen scores are unchanged.`, '',
    `Name lookups: strict ${result.name.strictMatches}/${result.name.total}; revised formatting ${result.name.candidateMatches}/${result.name.total}.`,
    `MBID lookups (separate): strict ${result.mbid.strictMatches}/${result.mbid.total}; revised formatting ${result.mbid.candidateMatches}/${result.mbid.total}.`, '',
    'These comparisons do not establish edition identity in actual scrobbles. Remaining differences are unresolved, not automatically different recordings.', '',
    ...result.rules.map((rule) => `- ${rule}`), '', '| Edition | Frozen name match | Revised name match | Revised MBID match |', '| --- | --- | --- | --- |',
    ...result.albums.map((r) => `| ${r.id} | ${r.name.strict.correct} | ${r.name.candidate.correct} (${r.name.candidate.status}) | ${r.mbid.candidate.correct} (${r.mbid.candidate.status}) |`), ''];
  lines.push('## Reviewed edition-specific aliases', '',
    `Name lookups: ${result.name.reviewedAliasMatches}/40 complete matches after reviewed aliases; ${result.name.reviewedAlias80PercentCoverage}/40 with 80% reference coverage. Formatting-only and frozen scores above remain unchanged.`,
    `MBID lookups: ${result.mbid.reviewedAliasMatches}/40 complete matches after reviewed aliases.`, '',
    'Post-hoc, sample-specific metadata review; not independently validated playback. Aliases require the exact reference hash, album label/artist and track count. They do not select editions or modify controlled-session scoring.', '',
    '| Edition / lookup | Alias-assisted complete match | Alias-assisted matched/reference | Applied aliases |', '| --- | --- | --- | --- |');
  for (const album of result.albums) for (const lookup of ['name', 'mbid']) {
    const r = album[lookup].reviewed;
    lines.push(`| ${album.id} / ${lookup} | ${r.comparison.correct} | ${r.coverage ? `${r.coverage.matched}/${r.coverage.referenceTotal}` : 'unavailable'} | ${r.applied.length} |`);
  }
  lines.push('', `Alias manifest: ${result.aliasManifestHash}`, `Alias code: ${result.aliasCodeHash}`, '', 'JSON retains each applied mapping, review rationale, and source links.', '');
  lines.push('## Track-level coverage', '',
    'Unique one-to-one title/artist matches, independent of order. Duplicate identities and conflicting credits do not count. Missing evidence is unavailable, not zero coverage.', '',
    `Name-query editions with at least 80% reference coverage: ${result.name.atLeast80PercentReferenceCoverage}/${result.name.total}; coverage available for ${result.name.coverageAvailable}/${result.name.total}.`,
    `MBID-query editions with at least 80% reference coverage: ${result.mbid.atLeast80PercentReferenceCoverage}/${result.mbid.total}; coverage available for ${result.mbid.coverageAvailable}/${result.mbid.total}.`, '',
    'This measures matchable metadata, not listening. Reaching 80% here neither verifies an edition nor means a user listened to those tracks. Different denominators and ordering remain separate checks.', '',
    '| Edition / lookup | Strict matched / reference | Revised matched / reference | Reference coverage | Returned coverage | Reference 80% target | Enough matching tracks |',
    '| --- | --- | --- | --- | --- | --- | --- |');
  for (const album of result.albums) for (const lookup of ['name', 'mbid']) {
    const coverage = album[lookup].coverage; const c = coverage.candidate;
    lines.push(c
      ? `| ${album.id} / ${lookup} | ${coverage.strict.matched}/${c.referenceTotal} | ${c.matched}/${c.referenceTotal} | ${c.referencePercent.toFixed(1)}% | ${c.returnedPercent.toFixed(1)}% | ${c.requiredReferenceTracks} | ${c.enoughReferenceTracksFor80Percent} |`
      : `| ${album.id} / ${lookup} | — | — | unavailable (${coverage.status}) | — | — | — |`);
  }
  lines.push('', 'JSON includes matched reference/returned positions, unmatched positions, and ambiguous duplicate positions.', '');
  for (const album of result.albums) for (const lookup of ['name', 'mbid']) {
    const differences = album[lookup].differences;
    if (!differences.length) continue;
    lines.push(`## ${album.id} — ${lookup}`, '', `Reference: ${album.referenceSource}. Capture: ${lookup === 'name' ? album.nameCapturedAt : album.mbidCapturedAt}.`, '',
      '| Position | Reference title / artist | Returned title / artist | Formatting resolves |', '| --- | --- | --- | --- |',
      ...differences.map((d) => `| ${d.position} | ${escape(d.expected ? `${d.expected.title} / ${d.expected.artist}` : null)} | ${escape(d.actual ? `${d.actual.title} / ${d.actual.artist}` : null)} | ${d.resolvedByFormatting} |`), '');
  }
  lines.push(`Study snapshot: ${result.studySnapshotHash}`, `Diagnostic rules: ${result.diagnosticRulesHash}`, '');
  return lines.join('\n');
}
function identityMarkdown(result) {
  const p = result.playback;
  return ['# Edition identity and playback report', '', `Conclusion: **${result.conclusion}**.`, '',
    'Different album titles are metadata observations, not proof that a player preserves those titles in scrobbles. Equal track counts do not establish equal membership.', '',
    `Actual sessions scored: ${p.completed}/${p.total}. Correct edition sessions: ${p.correctEditionSessions}; wrong-edition logs: ${p.wrongEditionLogs}; false-positive sessions: ${p.falsePositiveSessions}.`,
    `Shared-standard correct sessions: ${p.correctStandardSessions}; false-positive sessions: ${p.standardFalsePositiveSessions}. Zero errors with no sessions is not a pass.`,
    `Playback matcher: ${p.matcher}.`, '', '| Edition | Reference / returned tracks | Reference / returned 80% threshold | Revised list matches | Duplicate title positions |', '| --- | --- | --- | --- | --- |',
    ...result.baselines.map((b) => `| ${b.id} | ${escape(b.expectedCount)} / ${escape(b.returnedCount)} | ${escape(b.expectedThreshold)} / ${escape(b.returnedThreshold)} | ${b.candidateTracklistMatches} | ${escape(JSON.stringify(b.duplicateTitlePositions))} |`), '',
    '| Pair | Metadata available | Different returned titles | Same populated MBID | Both revised lists match |', '| --- | --- | --- | --- | --- |',
    ...result.pairs.map((p) => `| ${p.id} | ${p.status} | ${escape(p.differentReturnedTitles)} | ${escape(p.samePopulatedMbid)} | ${p.bothCandidateTracklistsMatch} |`), '',
    '| Actual control | Edition result | Standard result |', '| --- | --- | --- |',
    ...p.sessions.map((s) => `| ${s.id} | ${s.edition.status}${s.edition.status === 'scored' ? `; correct=${s.edition.correct}` : ''} | ${s.standard.status}${s.standard.status === 'scored' ? `; correct=${s.standard.correct}` : ''} |`), '',
    'JSON includes proposed listens, unresolved outcomes, and independent-control results. Refer to the original pilot report for the frozen go/no-go gates.', '',
    `Study snapshot: ${result.studySnapshotHash}`, `Diagnostic rules: ${result.diagnosticRulesHash}`, ''].join('\n');
}
module.exports = { canonicalTrack, candidateComparison, buildDiagnostics, matchingMarkdown, identityMarkdown };
