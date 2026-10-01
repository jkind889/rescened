const manifest = require('../../data/listening-study/reviewed-aliases.json');
const { hash, text, normalizeAlbum } = require('./core');

// Apply only to a copy of a metadata response, never to scrobbles or production data.
function applyReviewedAliases(editionId, reference, record) {
  const bundle = manifest.bundles.find((b) => b.editionId === editionId);
  const album = normalizeAlbum(record?.payload);
  const none = { record, applied: [] };
  if (!bundle || record?.status !== 'ok' || album.status !== 'ok' || hash(reference) !== bundle.referenceHash
    || reference.releaseMbid !== bundle.releaseMbid || text(album.title) !== text(bundle.albumTitle)
    || text(album.artist) !== text(bundle.albumArtist) || album.tracks.length !== bundle.trackCount) return none;
  const copy = structuredClone(record);
  const raw = copy.payload.album.tracks.track;
  const tracks = Array.isArray(raw) ? raw : [raw];
  const applied = [];
  for (const alias of bundle.aliases) {
    const target = reference.tracks[alias.referencePosition - 1];
    if (!target || target.releaseTrackMbid !== alias.releaseTrackMbid
      || text(target.title) !== text(alias.to.title) || text(target.artist) !== text(alias.to.artist)) continue;
    const matching = album.tracks.flatMap((track, i) => text(track.title) === text(alias.from.title)
      && text(track.artist) === text(alias.from.artist) ? [i] : []);
    // Never use row position to disambiguate identical incoming tracks.
    if (matching.length !== 1) continue;
    const index = matching[0];
    if (album.tracks.some((track, i) => i !== index && text(track.title) === text(alias.to.title)
      && text(track.artist) === text(alias.to.artist))) continue;
    tracks[index].name = alias.to.title;
    tracks[index].artist = { name: alias.to.artist };
    applied.push({ referencePosition: alias.referencePosition, returnedPosition: index + 1,
      from: alias.from, to: alias.to, sources: bundle.sources, rationale: bundle.rationale });
  }
  return { record: copy, applied };
}
module.exports = { applyReviewedAliases, manifest };
