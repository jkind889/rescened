const crypto = require("node:crypto");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { createListeningMusicBrainz } = require("./musicBrainz");
const { normalize, catalogRevisionOf } = require("./common");
const SAFE_SUFFIX = /(?:\s*[-–—:]\s*)?(?:\((?:deluxe(?: edition| version)?|expanded(?: edition)?|bonus(?: track)?(?: edition| version)?|\d{1,3}(?:st|nd|rd|th) anniversary(?: edition)?)\)|(?:deluxe|expanded|bonus track|\d{1,3}(?:st|nd|rd|th) anniversary) edition)$/iu;
const DISTINCT_WORK = /\b(?:live|remix(?:ed)?|acoustic|instrumental|re-recorded|rerecorded|taylor(?:'s|’s) version)\b/iu;
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function simplifiedTitle(value) {
  const title = String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  const match = SAFE_SUFFIX.exec(title);
  if (!match || DISTINCT_WORK.test(match[0])) return "";
  const simplified = title.slice(0, match.index).replace(/[\s:–—-]+$/gu, "").trim();
  return simplified && normalize(simplified) !== normalize(title) ? simplified : "";
}
function candidate(row, evidence) { return { albumId: row.albumId, title: row.title, artistDisplayName: row.artistDisplayName, catalogRevision: catalogRevisionOf(row), evidence }; }
function trackEvidence(providerTracks, catalogTracks) {
  const provider = providerTracks.map(normalize).filter(Boolean);
  const catalog = catalogTracks.map((row) => normalize(row.title)).filter(Boolean);
  const duplicates = (items) => [...new Set(items.filter((item, index) => items.indexOf(item) !== index))];
  const duplicateTitles = [...new Set([...duplicates(provider), ...duplicates(catalog)])];
  const p = new Set(provider); const c = new Set(catalog);
  const sharedTracks = [...p].filter((title) => c.has(title) && !duplicateTitles.includes(title));
  return { source: "lastfm_album_info", sharedTracks, sharedTrackCount: sharedTracks.length, missingTracks: [...c].filter((title) => !p.has(title)), extraTracks: [...p].filter((title) => !c.has(title)), duplicateTitles, providerTrackCount: provider.length, catalogTrackCount: catalog.length, countDifference: provider.length - catalog.length };
}
function stableEvidenceHash(value) {
  const stable = JSON.stringify(value, (key, field) => ["retrievedAt", "refreshedAt", "providerMetadataError"].includes(key) ? undefined : field);
  return crypto.createHash("sha256").update(stable).digest("hex");
}
function artistMatches(row, artist) {
  // Recent-track artists do not establish album-artist identity from guest credits.
  return normalize(row.artistDisplayName || row.artist) === normalize(artist);
}
function mergeCandidates(groups) {
  const byId = new Map();
  for (const group of groups) for (const item of group) {
    const current = byId.get(item.albumId);
    if (current) current.evidence.push(...item.evidence);
    else byId.set(item.albumId, { ...item, evidence: [...item.evidence] });
  }
  const rank = (item) => item.evidence.some((entry) => entry.type === "exact_local") ? 3 : item.evidence.some((entry) => entry.type === "verified_release_group") ? 2 : 1;
  return [...byId.values()].sort((a, b) => rank(b) - rank(a) || a.title.localeCompare(b.title) || a.albumId.localeCompare(b.albumId)).slice(0, 5);
}
function createDiscoveryService(options = {}) {
  const Catalog = options.AlbumCatalog || AlbumCatalog;
  const provider = options.provider;
  const musicBrainz = options.musicBrainz || createListeningMusicBrainz(options.musicBrainzOptions || {});
  const clock = options.clock || (() => new Date());
  const fields = "albumId title artistDisplayName catalogRevision tracks externalReferences";
  async function localByTitle(artist, title, type) {
    const rows = await Catalog.find({ title: new RegExp(`^${escapeRegex(title)}$`, "iu"), artistDisplayName: new RegExp(`^${escapeRegex(artist)}$`, "iu") }).select(fields).sort({ albumId: 1 }).limit(20).lean();
    return rows.filter((row) => normalize(row.title) === normalize(title) && artistMatches(row, artist)).map((row) => candidate(row, [{ type, artist, album: title }]));
  }
  async function localReferences(ids, artist, evidence) {
    if (!ids.length) return [];
    const rows = await Catalog.find({ externalReferences: { $elemMatch: { provider: "musicbrainz", entityType: "release-group", externalId: { $in: ids } } } }).select(fields).sort({ albumId: 1 }).limit(20).lean();
    return rows.filter((row) => artistMatches(row, artist)).map((row) => candidate(row, evidence));
  }
  async function discover({ artist, album }) {
    const retrievedAt = clock().toISOString();
    const exact = await localByTitle(artist, album, "exact_local");
    const simplified = simplifiedTitle(album);
    const simplifiedMatches = simplified ? await localByTitle(artist, simplified, "simplified_edition_label") : [];
    const errors = []; let albumMetadata = null; let relationship = null; let searched = []; let verified = []; let providerSearch = [];
    if (provider) {
      try { albumMetadata = await provider.albumInfo({ artist, album }); }
      catch { errors.push("lastfm_album_info_unavailable"); }
    }
    if (albumMetadata?.mbid && musicBrainz.releaseRelationship) {
      try {
        relationship = await musicBrainz.releaseRelationship(albumMetadata.mbid);
        if (relationship && artistMatches(relationship, artist)) verified = await localReferences([relationship.releaseGroupMbid], artist, [{ type: "verified_release_group", ...relationship }]);
      } catch { errors.push("musicbrainz_release_lookup_unavailable"); }
    }
    try {
      const remote = await musicBrainz.searchReleaseGroups(`${artist} ${simplified || album}`, 5);
      const valid = remote.filter((row) => artistMatches(row, artist) && [normalize(album), normalize(simplified)].includes(normalize(row.title)));
      providerSearch = valid.map(({ externalId, title, artistDisplayName }) => ({ externalId, title, artistDisplayName })).sort((a, b) => a.externalId.localeCompare(b.externalId));
      for (const row of valid) searched.push(...await localReferences([row.externalId], artist, [{ type: "musicbrainz_search_candidate", releaseGroupMbid: row.externalId, sourceUrl: `https://musicbrainz.org/release-group/${row.externalId}`, retrievedAt }]));
    } catch { errors.push("musicbrainz_search_unavailable"); }
    const candidates = mergeCandidates([exact, verified, simplifiedMatches, searched]);
    const catalog = candidates.length ? await Catalog.find({ albumId: { $in: candidates.map((item) => item.albumId) } }).select(fields).lean() : [];
    const byId = new Map(catalog.map((row) => [row.albumId, row]));
    for (const item of candidates) {
      const row = byId.get(item.albumId);
      const conflicts = [];
      if (albumMetadata && !artistMatches(albumMetadata, artist)) conflicts.push("Last.fm album artist differs from the recent-track artist");
      if (relationship && !(row?.externalReferences || []).some((ref) => ref.provider === "musicbrainz" && ref.entityType === "release-group" && ref.externalId === relationship.releaseGroupMbid)) conflicts.push("Verified release group differs from catalog references");
      item.evidence.push({ source: "candidate_comparison", sourceUrl: albumMetadata?.url || "", retrievedAt: albumMetadata?.retrievedAt || retrievedAt, identifierConflicts: conflicts, ...(albumMetadata ? trackEvidence(albumMetadata.tracks || [], row?.tracks || []) : {}), duplicateTitleAmbiguity: candidates.filter((other) => normalize(other.title) === normalize(item.title)).length > 1 });
    }
    const evidence = [{ source: "candidate_discovery", retrievedAt, simplifiedTitle: simplified, providerMetadataAvailable: Boolean(albumMetadata), providerMetadataError: errors.join(","), sourceUrl: albumMetadata?.url || "", duplicateTitleAmbiguity: candidates.length > 1 }];
    return { candidates, evidence, incomplete: errors.length > 0, evidenceHash: stableEvidenceHash({ albumMetadata, relationship, providerSearch }) };
  }
  return { discover };
}
module.exports = { createDiscoveryService, simplifiedTitle, trackEvidence, stableEvidenceHash };
