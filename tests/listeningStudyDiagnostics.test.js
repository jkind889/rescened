const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canonicalTrack, candidateComparison, buildDiagnostics, matchingMarkdown, identityMarkdown } = require('../lib/listeningStudy/diagnostics');
const { createStudy } = require('../lib/listeningStudy/study');
const { main } = require('../scripts/lastfmStudy');
const key = (title, artist = 'Artist') => canonicalTrack({ title, artist }).key;
function evidence(expected, actual) {
  return [{ verified: true, title: 'Album', queryTitle: 'Album', artist: 'Artist', tracks: expected },
    { status: 'ok', payload: { album: { name: 'Album', artist: 'Artist', tracks: { track: actual.map((t, i) => ({ name: t.title, artist: { name: t.artist }, '@attr': { rank: i + 1 } })) } } } }];
}
test('hyphen formatting improves comparison without mutating frozen scores', () => {
  const input = evidence([{ title: 'Heart‐Shaped', artist: 'Artist' }], [{ title: 'Heart-Shaped', artist: 'Artist' }]);
  const before = JSON.stringify(input); const r = candidateComparison(...input);
  assert.equal(r.strict.correct, false); assert.equal(r.candidate.correct, true);
  assert.equal(JSON.stringify(input), before);
});
test('featured credits move across fields, retain guests, and handle duplicated credits', () => {
  assert.equal(key('Song', 'Artist feat. Guest'), key('Song (feat. Guest)', 'Artist'));
  assert.equal(key('Song', 'Artist feat. A & B'), key('Song [featuring B and A]', 'Artist'));
  assert.equal(key('Song', 'Artist feat. Guest'), key('Song [feat. Guest]', 'Artist [feat. Guest]'));
  assert.notEqual(key('Song', 'Artist feat. Guest'), key('Song', 'Artist'));
  assert.notEqual(key('Song', 'Artist feat. Guest'), key('Song', 'Other feat. Guest'));
  assert.equal(key('Song (feat. Other)', 'Artist feat. Guest'), null);
});
test('version qualifiers and edition-significant punctuation are preserved', () => {
  for (const suffix of ['(live)', '(remix)', '(demo)', '(acoustic)', '(remastered)', '(bonus track)']) {
    assert.notEqual(key('Song'), key(`Song ${suffix}`));
  }
  assert.notEqual(key('[untitled]'), key('Untitled'));
});
test('same count with replacements and reordered lists cannot pass', () => {
  const track = (title) => ({ title, artist: 'Artist' });
  assert.equal(candidateComparison(...evidence([track('A'), track('B')], [track('A'), track('C')])).candidate.correct, false);
  const reordered = candidateComparison(...evidence([track('A'), track('B')], [track('B'), track('A')]));
  assert.equal(reordered.candidate.membership, true); assert.equal(reordered.candidate.order, false);
});
test('missing and unavailable input stays incomplete, not rescued by normalization', () => {
  assert.equal(candidateComparison(null, null).candidate.status, 'reference_missing');
  const [ref, record] = evidence([{ title: 'A', artist: 'Artist' }], []);
  assert.equal(candidateComparison(ref, record).candidate.status, 'missing_tracklist');
  assert.equal(candidateComparison(ref, { status: 'unavailable' }).candidate.status, 'incomplete');
});
test('identity report separates matching labels from missing playback and duplicate positions', () => {
  const study = createStudy();
  for (const kind of ['standard', 'deluxe']) {
    const id = `born-to-die:${kind}`;
    const [ref, record] = evidence([{ title: 'A', artist: 'Artist' }, { title: 'A', artist: 'Artist' }], [{ title: 'A', artist: 'Artist' }, { title: 'A', artist: 'Artist' }]);
    study.references[id] = ref; study.albums[id] = { name: record };
  }
  const before = JSON.stringify(study); const { matching, identity } = buildDiagnostics(study);
  assert.equal(identity.playback.completed, 0); assert.equal(identity.conclusion, 'actual_playback_incomplete');
  assert.equal(identity.pairs[0].differentReturnedTitles, false);
  assert.deepEqual(identity.baselines[0].duplicateTitlePositions, [[1, 2]]);
  assert.equal(matching.name.total, 40); assert.equal(matching.mbid.candidateMatches, 0);
  assert.match(matchingMarkdown(matching), /Frozen scores are unchanged/);
  assert.match(identityMarkdown(identity), /Zero errors with no sessions is not a pass/);
  assert.equal(JSON.stringify(study), before);
});
test('diagnose writes two offline reports and preserves existing frozen artifacts byte-for-byte', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'study-diagnostics-'));
  try {
    await main(['init', '--output', dir]);
    const before = await fs.readFile(path.join(dir, 'study.json'), 'utf8');
    await fs.writeFile(path.join(dir, 'report.json'), 'frozen sentinel');
    await main(['diagnose', '--output', dir]);
    assert.equal(await fs.readFile(path.join(dir, 'study.json'), 'utf8'), before);
    assert.equal(await fs.readFile(path.join(dir, 'report.json'), 'utf8'), 'frozen sentinel');
    for (const name of ['track-matching-report', 'edition-evidence-report']) {
      assert.ok((await fs.readFile(path.join(dir, `${name}.md`), 'utf8')).length > 0);
      assert.equal(JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf8')).postHoc, true);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('19/20 coverage is useful without turning a failed complete-list check into a pass', () => {
  const expected = Array.from({ length: 20 }, (_, i) => ({ title: `Song ${i}`, artist: 'Artist' }));
  const actual = expected.map((t) => ({ ...t })); actual[19].title = 'Other';
  const result = candidateComparison(...evidence(expected, actual));
  assert.equal(result.candidate.correct, false);
  assert.equal(result.coverage.candidate.matched, 19);
  assert.equal(result.coverage.candidate.referencePercent, 95);
  assert.equal(result.coverage.candidate.requiredReferenceTracks, 16);
  assert.equal(result.coverage.candidate.enoughReferenceTracksFor80Percent, true);
});
test('coverage ignores ordering, distinguishes denominators, and does not inflate duplicate titles', () => {
  const t = (title) => ({ title, artist: 'Artist' });
  const result = candidateComparison(...evidence([t('A'), t('B')], [t('B'), t('A'), t('Bonus')]));
  assert.equal(result.coverage.candidate.matched, 2);
  assert.equal(result.coverage.candidate.referencePercent, 100);
  assert.equal(result.coverage.candidate.returnedPercent, 2 / 3 * 100);
  assert.equal(result.candidate.correct, false);
  const duplicate = candidateComparison(...evidence([t('A'), t('A'), t('B')], [t('A'), t('A'), t('B')]));
  assert.equal(duplicate.coverage.candidate.matched, 1);
  assert.deepEqual(duplicate.coverage.candidate.ambiguousReferencePositions, [1, 2]);
  assert.equal(candidateComparison(null, null).coverage.candidate, null);
});
test('coverage boundary uses integer ceiling and revised formatting separately', () => {
  const expected = Array.from({ length: 6 }, (_, i) => ({ title: `Song‐${i}`, artist: 'Artist' }));
  for (const count of [4, 5]) {
    const result = candidateComparison(...evidence(expected, expected.slice(0, count).map((t) => ({ ...t, title: t.title.replace('‐', '-') }))));
    assert.equal(result.coverage.strict.matched, 0);
    assert.equal(result.coverage.candidate.matched, count);
    assert.equal(result.coverage.candidate.requiredReferenceTracks, 5);
    assert.equal(result.coverage.candidate.enoughReferenceTracksFor80Percent, count === 5);
  }
});

test('reviewed aliases are reference- and edition-scoped and leave source evidence unchanged', () => {
  const { applyReviewedAliases, manifest } = require('../lib/listeningStudy/reviewedAliases');
  const refs = require('../data/listening-study/references.json');
  for (const bundle of manifest.bundles) {
    const ref = refs[bundle.editionId];
    const actual = ref.tracks.map((t) => ({ title: t.title, artist: t.artist }));
    for (const alias of bundle.aliases) actual[alias.referencePosition - 1] = { ...alias.from };
    const [, record] = evidence(actual, actual);
    record.payload.album.name = bundle.albumTitle;
    record.payload.album.artist = bundle.albumArtist;
    const before = JSON.stringify(record);
    const result = applyReviewedAliases(bundle.editionId, ref, record);
    assert.equal(result.applied.length, bundle.aliases.length);
    assert.equal(candidateComparison(ref, result.record).candidate.correct, true);
    assert.equal(JSON.stringify(record), before);
    assert.equal(applyReviewedAliases('other:standard', ref, record).applied.length, 0);
    assert.equal(applyReviewedAliases(bundle.editionId, { ...ref, title: 'Changed reference' }, record).applied.length, 0);
    const other = structuredClone(record); other.payload.album.name = 'Other edition';
    assert.equal(applyReviewedAliases(bundle.editionId, ref, other).applied.length, 0);
    const missing = structuredClone(record); missing.payload.album.tracks.track.pop();
    assert.equal(applyReviewedAliases(bundle.editionId, ref, missing).applied.length, 0);
  }
});
test('reviewed alias will not remove additional live qualifiers or disambiguate duplicate incoming titles', () => {
  const { applyReviewedAliases } = require('../lib/listeningStudy/reviewedAliases');
  const ref = require('../data/listening-study/references.json')['hozier:standard'];
  const actual = ref.tracks.map((t) => ({ title: t.title, artist: t.artist }));
  const [, record] = evidence(actual, actual);
  record.payload.album.name = ref.queryTitle; record.payload.album.artist = ref.artist;
  record.payload.album.tracks.track[11].name = "Foregner's God (Live)";
  assert.equal(applyReviewedAliases('hozier:standard', ref, record).applied.length, 0);
  record.payload.album.tracks.track[11].name = "Foregner's God";
  record.payload.album.tracks.track[10].name = "Foregner's God";
  assert.equal(applyReviewedAliases('hozier:standard', ref, record).applied.length, 0);
});
