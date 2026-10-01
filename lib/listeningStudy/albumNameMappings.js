const fs = require('node:fs');
const { hash, text, normalizeRecent, evaluateSessions } = require('./core');
const { assertStudy, validateControl } = require('./study');
const manifest = require('../../data/listening-study/album-name-mappings.json');

function createNameResolver(mappings, definitions) {
  const index = new Map();
  for (const mapping of mappings) {
    if (!text(mapping.artist) || !Array.isArray(mapping.names) || !mapping.names.length
      || mapping.names.some((name) => !text(name)) || !mapping.targetStudyEditionId?.endsWith(':standard')) throw new Error('Invalid reviewed album-name mapping');
    for (const name of mapping.names) {
      const key = JSON.stringify([text(mapping.artist), text(name)]);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(mapping.targetStudyEditionId);
    }
  }
  return (event) => {
    if (event.identityConflict) return { status: 'identity_conflict' };
    const targets = index.get(JSON.stringify([text(event.artist), text(event.album)]));
    if (!targets) return { status: 'unknown_album_name' };
    if (targets.size !== 1) return { status: 'ambiguous_album_mapping' };
    const targetId = [...targets][0];
    const target = definitions.find((d) => d.id === targetId && d.kind === 'standard');
    return target ? { status: 'mapped', targetId, target } : { status: 'baseline_unavailable', targetId };
  };
}
function evaluateMappedEvents(events, mappings, definitions) {
  const resolve = createNameResolver(mappings, definitions);
  const accepted = []; const decisions = [];
  for (const event of events) {
    const decision = resolve(event);
    decisions.push({ eventId: event.id, sourceArtist: event.artist, sourceAlbum: event.album,
      status: decision.status, targetStudyEditionId: decision.targetId || null });
    if (decision.status === 'mapped') {
      const aliases = (decision.target.trackAliases || []).filter((a) => text(a.artist) === text(event.artist) && text(a.fromTitle) === text(event.title));
      const title = aliases.length === 1 ? decision.target.tracks[aliases[0].referencePosition - 1].title : event.title;
      accepted.push({ ...event, title, album: decision.target.id, albumMbid: '' });
    }
  }
  // Release MBIDs identify source editions, not the standard baseline. Keep them in raw evidence,
  // but do not compare them to the baseline. Track identifiers still use the frozen conflict rules.
  const result = evaluateSessions(accepted, definitions.map((d) => ({ ...d, aliases: [d.id], mbid: '' })), 'standard');
  return { ...result, decisions, mappedRows: accepted.length,
    unmappedRows: decisions.filter((d) => d.status !== 'mapped').length,
    excludedTrackRows: result.unresolved.length, proposedListens: result.sessions.filter((s) => s.status === 'would_log').length };
}
function mappingReport(study, supplemental = []) {
  assertStudy(study);
  if (!Array.isArray(supplemental)) throw new Error('Supplemental evidence must be an array of {control, capture}');
  const targetIds = manifest.mappings.map((m) => m.targetStudyEditionId);
  if (new Set(targetIds).size !== targetIds.length) throw new Error('Duplicate target definitions: keep reviewed names and track aliases in one mapping');
  const baselineStatus = []; const definitions = [];
  for (const mapping of manifest.mappings) {
    if (!mapping.reviewer || !mapping.reviewedAt || !mapping.sources?.length) throw new Error('Mapping review provenance missing');
    const id = mapping.targetStudyEditionId; const reference = study.references[id];
    const valid = reference?.verified && hash(reference) === mapping.referenceHash
      && text(reference.artist) === text(mapping.artist) && hash(reference.tracks) === mapping.standardTracklistHash;
    baselineStatus.push({ targetStudyEditionId: id, status: valid ? 'reviewed_baseline_available' : 'baseline_missing_or_changed' });
    if (valid && !definitions.some((d) => d.id === id)) {
      for (const alias of mapping.trackAliases || []) {
        const track = reference.tracks[alias.referencePosition - 1];
        if (!track || !text(alias.fromTitle) || text(alias.artist) !== text(track.artist)
          || alias.releaseTrackMbid !== track.releaseTrackMbid || !alias.rationale) throw new Error('Invalid reviewed standard-track alias');
      }
      definitions.push({ id, pairId: id.slice(0, -':standard'.length), kind: 'standard', tracks: reference.tracks, trackAliases: mapping.trackAliases || [] });
    }
  }
  const controls = [...study.controls.map((control) => ({ control, capture: study.captures[control.id], supplemental: false })),
    ...supplemental.map((row) => ({ ...row, supplemental: true }))];
  const ids = controls.map((row) => row.control?.id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Missing or duplicate control IDs');
  const allEvents = new Map();
  const results = controls.map(({ control, capture, supplemental: extra }) => {
    if (!control.confirmed || !capture?.complete || capture.source !== 'lastfm_live' || capture.controlHash !== hash(control)) {
      return { id: control.id, supplemental: extra, status: 'incomplete' };
    }
    validateControl(control, { ...study, controls: controls.map((r) => r.control) });
    const parsed = normalizeRecent(capture.pages);
    const events = parsed.events.filter((e) => e.timestamp >= control.from && e.timestamp <= control.to);
    for (const event of events) allEvents.set(event.id, event);
    return { id: control.id, supplemental: extra, status: 'evaluated', rejectedRows: parsed.rejected.length,
      ...evaluateMappedEvents(events, manifest.mappings, definitions) };
  });
  return { version: 'album-name-mapping-study-1.0.0', generatedAt: new Date().toISOString(),
    studySnapshotHash: hash(study), supplementalHash: hash(supplemental), manifestHash: hash(manifest),
    codeHash: hash(fs.readFileSync(__filename, 'utf8')), frozenRulesHash: study.rulesHash,
    postHoc: true, scope: manifest.scope, baselineStatus, mappings: manifest.mappings, controls: results,
    combined: evaluateMappedEvents([...allEvents.values()], manifest.mappings, definitions),
    limitation: 'Proposed listens only. Not a frozen pilot pass. No expectedLog oracle is inferred from provider metadata. Per-control windows are separate tests; combined evaluation applies actual session gaps across all supplied windows.' };
}
function mappingMarkdown(report) {
  return ['# Reviewed album-name mapping report', '', report.scope, '', report.limitation, '',
    '| Control | Supplemental | Status | Mapped / unmapped rows | Excluded tracks | Counted standard tracks | Proposed listens |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.controls.map((r) => `| ${r.id} | ${r.supplemental} | ${r.status} | ${r.mappedRows ?? '—'} / ${r.unmappedRows ?? '—'} | ${r.excludedTrackRows ?? '—'} | ${r.sessions?.map((s) => `${s.distinctTracks}/${s.totalTracks}`).join(', ') || '—'} | ${r.proposedListens ?? '—'} |`), '',
    `Combined windows: ${report.combined.sessions.length} detected sessions; ${report.combined.proposedListens} proposed listens. Windows separated by less than the configured gap can merge.`, '',
    'Unknown names, other artists, conflicting mappings, changed baselines and ambiguous tracks remain unresolved. Recognizing an album does not make bonus tracks count.', '',
    'JSON retains source names, mapping decisions, baseline status, provenance, and combined-session details. No diary writes or manual-entry changes occur.', '',
    `Mapping manifest: ${report.manifestHash}`, `Study snapshot: ${report.studySnapshotHash}`, ''].join('\n');
}
module.exports = { createNameResolver, evaluateMappedEvents, mappingReport, mappingMarkdown };
