// Local artist pages: the registry header, the artist's linked releases in the
// Rescened catalog, and artist search. Everything reads local collections; no
// provider is contacted. A release belongs to an artist only through an
// explicit artistId on one of its credits. Display names are never split or
// compared to infer identity, so homonyms stay separate artists.

const AlbumCatalog = require("../../models/AlbumCatalog");
const Artist = require("../../models/Artist");
const { buildRankedSearchPattern } = require("../../routes/utils/catalogSearch");
const { artistMbidOf, loadArtistsById, loadArtistsByMbid, normalizeArtistId } = require("./identity");
const { REVIEWED_ARTIST_ALIASES, reviewedAliasesFor } = require("./reviewedAliases");
const { isArtistBiographiesEnabled, isArtistDiscographyEnabled } = require("../../routes/utils/serverConfig");

const RELEASE_GROUPS = {
  album: ["album"],
  ep: ["ep"],
  single: ["single"],
  mixtape: ["mixtape"],
  other: ["soundtrack", "compilation", "live", "remix", "other"],
};
const RELEASE_FILTERS = ["all", ...Object.keys(RELEASE_GROUPS)];
const DEFAULT_RELEASE_LIMIT = 24;
const MAX_RELEASE_LIMIT = 48;
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 12;
const MAX_QUERY_LENGTH = 200;
const MAX_CURSOR_LENGTH = 2048;
const CANDIDATE_LIMIT = 50;
const MAX_CREDITED_NAMES = 20;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function artistError(message, status = 400, code = "INVALID_ARTIST_REQUEST") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// Comparison key for whole names: NFC, collapsed whitespace, equivalent
// apostrophes, lowercase, and canonical Latin accents folded (as in catalog
// search). Other scripts are kept exactly; there is no transliteration.
function foldSearchKey(value) {
  return [...String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim().replace(/’/gu, "'").toLowerCase()]
    .map((character) => {
      const code = character.codePointAt(0);
      if (code < 0xc0 || code > 0x24f) return character;
      const base = character.normalize("NFD").replace(/\p{M}/gu, "");
      return /^[a-z]$/.test(base) ? base : character;
    })
    .join("");
}

function requireArtistId(value) {
  const artistId = normalizeArtistId(value);
  if (!artistId) throw artistError("artistId must be a Rescened artist ID", 400, "INVALID_ARTIST_ID");
  return artistId;
}

async function findArtist(artistId) {
  const artist = await Artist.findOne({ artistId }).select("artistId name externalReferences").lean();
  if (!artist) throw artistError("Artist not found", 404, "ARTIST_NOT_FOUND");
  return artist;
}

function musicBrainzUrl(artist) {
  const mbid = artistMbidOf(artist);
  return mbid ? `https://musicbrainz.org/artist/${mbid}` : null;
}

function publicCredit(credit) {
  const artistId = normalizeArtistId(credit?.artistId);
  return { name: credit?.name || "", role: credit?.role || "main", ...(artistId ? { artistId } : {}) };
}

// A catalog row without a releaseType is an album (the model default), here
// and in the release filter, so counts, filters, and card labels agree.
function releaseGroupOf(releaseType) {
  const type = releaseType || "album";
  return Object.keys(RELEASE_GROUPS).find((group) => RELEASE_GROUPS[group].includes(type)) || "other";
}

function releaseTypeMatch(group) {
  return group === "album" ? { $in: [...RELEASE_GROUPS.album, null] } : { $in: RELEASE_GROUPS[group] };
}

async function artistDetail(rawArtistId) {
  const artistId = requireArtistId(rawArtistId);
  const artist = await findArtist(artistId);
  const [summary] = await AlbumCatalog.aggregate([
    { $match: { "artistCredits.artistId": artistId } },
    { $project: {
      releaseType: 1,
      names: { $map: {
        input: { $filter: { input: "$artistCredits", as: "credit", cond: { $eq: ["$$credit.artistId", artistId] } } },
        as: "credit", in: "$$credit.name",
      } },
    } },
    { $facet: {
      types: [{ $group: { _id: "$releaseType", count: { $sum: 1 } } }],
      names: [
        { $unwind: "$names" },
        { $group: { _id: "$names", count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: MAX_CREDITED_NAMES + 1 },
      ],
    } },
  ]);
  const releaseCounts = Object.fromEntries(RELEASE_FILTERS.map((filter) => [filter, 0]));
  for (const row of summary?.types || []) {
    releaseCounts[releaseGroupOf(row._id)] += row.count;
    releaseCounts.all += row.count;
  }
  // Credited spellings other than the registry heading, most used first. The
  // album credits keep their wording; the header only lists them.
  const headingKey = foldSearchKey(artist.name);
  const creditedAs = (summary?.names || [])
    .map((row) => row._id)
    .filter((name) => typeof name === "string" && name && foldSearchKey(name) !== headingKey)
    .slice(0, MAX_CREDITED_NAMES);
  return {
    artist: {
      artistId: artist.artistId,
      name: artist.name,
      aliases: reviewedAliasesFor(artistMbidOf(artist)).map((alias) => ({ ...alias })),
      creditedAs,
      musicBrainzUrl: musicBrainzUrl(artist),
    },
    releaseCounts,
    // Optional sections this API serves for this artist. The page mounts the
    // MusicBrainz discography only when this says so, so an older API, a
    // disabled flag, or an artist without a MusicBrainz identity leaves the
    // page without the section (and spends no external-search request).
    // biography: the page may ask for the cached biography (it can still be
    // absent); it is served from MongoDB only.
    features: { discography: isArtistDiscographyEnabled() && Boolean(artistMbidOf(artist)), biography: isArtistBiographiesEnabled() },
  };
}

function parseReleaseQuery(query = {}) {
  for (const key of Object.keys(query)) {
    if (!["type", "cursor", "limit"].includes(key) || typeof query[key] !== "string") {
      throw artistError(`Unsupported query field ${key}`, 400, "INVALID_ARTIST_RELEASES");
    }
  }
  const type = query.type || "all";
  if (!RELEASE_FILTERS.includes(type)) throw artistError(`type must be one of ${RELEASE_FILTERS.join(", ")}`, 400, "INVALID_ARTIST_RELEASES");
  const limit = query.limit === undefined ? DEFAULT_RELEASE_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RELEASE_LIMIT) {
    throw artistError(`limit must be 1-${MAX_RELEASE_LIMIT}`, 400, "INVALID_ARTIST_RELEASES");
  }
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > MAX_CURSOR_LENGTH)) {
    throw artistError("cursor is invalid", 400, "INVALID_ARTIST_CURSOR");
  }
  return { type, limit, cursor: query.cursor || null };
}

// Opaque keyset cursor: newest first, then title and the public albumId.
// Mongo _id values never appear in it.
function encodeReleaseCursor(type, row) {
  return Buffer.from(JSON.stringify({ t: type, y: row.yearKey, d: row.dateKey, n: row.title, id: row.albumId })).toString("base64url");
}

function decodeReleaseCursor(type, cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.t !== type || !Number.isInteger(value.y) || typeof value.d !== "string" || typeof value.n !== "string"
      || typeof value.id !== "string" || !UUID_V4.test(value.id)) {
      throw new Error("mismatch");
    }
    return { $or: [
      { yearKey: { $lt: value.y } },
      { yearKey: value.y, dateKey: { $lt: value.d } },
      { yearKey: value.y, dateKey: value.d, title: { $gt: value.n } },
      { yearKey: value.y, dateKey: value.d, title: value.n, albumId: { $gt: value.id } },
    ] };
  } catch {
    throw artistError("cursor is invalid", 400, "INVALID_ARTIST_CURSOR");
  }
}

// A release is a collaboration for this artist only when it credits someone
// else: a credit with a different artistId, or a credit with no identity,
// which the release lists as a separate party and which stays plain text.
// Several credits that share this artist's artistId (for example two
// spellings of one performer) are still one artist. Names are never compared.
function isOwnCredit(credit, artistId) {
  return normalizeArtistId(credit?.artistId) === artistId;
}

function hasOtherCreditedParty(credits, artistId) {
  return (Array.isArray(credits) ? credits : []).some((credit) => credit?.name && !isOwnCredit(credit, artistId));
}

function releaseCard(row, artistId) {
  const credits = Array.isArray(row.artistCredits) ? row.artistCredits : [];
  const ownCredits = credits.filter((credit) => isOwnCredit(credit, artistId));
  return {
    albumId: row.albumId,
    title: row.title || "",
    artistDisplayName: row.artistDisplayName || "",
    artistCredits: credits.map(publicCredit),
    releaseType: row.releaseType || "album",
    releaseYear: row.releaseYear ?? (row.yearKey >= 0 ? row.yearKey : null),
    cover: row.cover || "",
    creditRoles: [...new Set(ownCredits.map((credit) => credit.role || "main"))],
    collaboration: hasOtherCreditedParty(credits, artistId),
  };
}

async function artistReleases(rawArtistId, query) {
  const artistId = requireArtistId(rawArtistId);
  const options = parseReleaseQuery(query);
  const cursorMatch = decodeReleaseCursor(options.type, options.cursor);
  await findArtist(artistId);
  const match = { "artistCredits.artistId": artistId };
  if (options.type !== "all") match.releaseType = releaseTypeMatch(options.type);
  const rows = await AlbumCatalog.aggregate([
    { $match: match },
    { $project: { _id: 0, albumId: 1, title: 1, artistDisplayName: 1, artistCredits: 1, releaseType: 1, releaseYear: 1, releaseDate: 1, cover: 1 } },
    { $set: {
      yearKey: { $ifNull: ["$releaseYear", { $convert: {
        input: { $substrCP: [{ $ifNull: ["$releaseDate", ""] }, 0, 4] }, to: "int", onError: -1, onNull: -1,
      } }] },
      dateKey: { $ifNull: ["$releaseDate", ""] },
    } },
    ...(cursorMatch ? [{ $match: cursorMatch }] : []),
    { $sort: { yearKey: -1, dateKey: -1, title: 1, albumId: 1 } },
    { $limit: options.limit + 1 },
  ]);
  const page = rows.slice(0, options.limit);
  return {
    artistId,
    type: options.type,
    releases: page.map((row) => releaseCard(row, artistId)),
    nextCursor: rows.length > options.limit ? encodeReleaseCursor(options.type, page[page.length - 1]) : null,
  };
}

function parseSearch(query = {}) {
  for (const key of Object.keys(query)) {
    if (!["q", "limit"].includes(key) || typeof query[key] !== "string") {
      throw artistError(`Unsupported query field ${key}`, 400, "INVALID_ARTIST_SEARCH");
    }
  }
  const q = String(query.q || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (q.length > MAX_QUERY_LENGTH) throw artistError(`q must be at most ${MAX_QUERY_LENGTH} characters`, 400, "INVALID_ARTIST_SEARCH");
  const limit = query.limit === undefined ? DEFAULT_SEARCH_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw artistError(`limit must be 1-${MAX_SEARCH_LIMIT}`, 400, "INVALID_ARTIST_SEARCH");
  }
  return { q, limit };
}

function matchRank(name, key, kind) {
  const candidate = foldSearchKey(name);
  if (candidate === key) return kind === "name" ? 0 : 1;
  if (candidate.startsWith(key)) return 2;
  return candidate.includes(key) ? 3 : null;
}

// Artists whose registry name, a reviewed alias, or a credited spelling on a
// linked album matches the query. Results are per artistId: two artists who
// share a name are two results, distinguished by their releases.
async function searchArtists(query) {
  const { q, limit } = parseSearch(query);
  if (!q) return { results: [] };
  const key = foldSearchKey(q);
  const pattern = buildRankedSearchPattern(q);
  const aliasMatches = REVIEWED_ARTIST_ALIASES.flatMap((entry) => entry.aliases
    .filter((alias) => foldSearchKey(alias.name).includes(key))
    .map((alias) => ({ artistMbid: entry.artistMbid, alias })));

  // Candidates are capped, so order them by match quality first: an exact
  // name, then a prefix, then any substring. A common short query cannot push
  // the exactly named artist out of the capped list.
  const quality = (field) => ({ $switch: { branches: [
    { case: { $regexMatch: { input: field, regex: `^${pattern}$`, options: "i" } }, then: 0 },
    { case: { $regexMatch: { input: field, regex: `^${pattern}`, options: "i" } }, then: 1 },
  ], default: 2 } });
  const [byName, byMbid, credited] = await Promise.all([
    Artist.aggregate([
      { $match: { name: { $regex: pattern, $options: "i" } } },
      { $project: { _id: 0, artistId: 1, name: 1, externalReferences: 1, quality: quality("$name") } },
      { $sort: { quality: 1, name: 1, artistId: 1 } },
      { $limit: CANDIDATE_LIMIT },
    ]),
    loadArtistsByMbid(Artist, aliasMatches.map((match) => match.artistMbid)),
    AlbumCatalog.aggregate([
      { $match: { artistCredits: { $elemMatch: { name: { $regex: pattern, $options: "i" }, artistId: { $exists: true } } } } },
      { $unwind: "$artistCredits" },
      { $match: { "artistCredits.name": { $regex: pattern, $options: "i" }, "artistCredits.artistId": { $exists: true } } },
      { $group: { _id: "$artistCredits.artistId", names: { $addToSet: "$artistCredits.name" }, quality: { $min: quality("$artistCredits.name") } } },
      { $sort: { quality: 1, _id: 1 } },
      { $limit: CANDIDATE_LIMIT },
    ]),
  ]);

  const candidates = new Map();
  const consider = (artist, name, kind, locale) => {
    if (!artist?.artistId) return;
    const rank = matchRank(name, key, kind);
    if (rank === null) return;
    const current = candidates.get(artist.artistId);
    if (current && current.rank <= rank) return;
    candidates.set(artist.artistId, { artist, rank, match: kind === "name" ? null : { name, kind, ...(locale ? { locale } : {}) } });
  };
  byName.forEach((artist) => consider(artist, artist.name, "name"));
  aliasMatches.forEach(({ artistMbid, alias }) => consider(byMbid.get(artistMbid), alias.name, "alias", alias.locale));
  const creditedArtists = await loadArtistsById(Artist, credited.map((row) => row._id));
  credited.forEach((row) => {
    const artist = creditedArtists.get(row._id);
    (row.names || []).forEach((name) => {
      // A credit spelled like the registry name is a name match, not an alias.
      consider(artist, name, artist && foldSearchKey(name) === foldSearchKey(artist.name) ? "name" : "credit");
    });
  });
  if (!candidates.size) return { results: [] };

  const ids = [...candidates.keys()];
  const stats = await AlbumCatalog.aggregate([
    { $match: { "artistCredits.artistId": { $in: ids } } },
    { $project: { albumId: 1, title: 1, releaseYear: 1, linked: { $setIntersection: [{ $ifNull: ["$artistCredits.artistId", []] }, ids] } } },
    { $unwind: "$linked" },
    { $sort: { releaseYear: -1, title: 1, albumId: 1 } },
    { $group: { _id: "$linked", count: { $sum: 1 }, titles: { $push: "$title" } } },
    { $project: { count: 1, titles: { $slice: ["$titles", 2] } } },
  ]);
  const statsById = new Map(stats.map((row) => [row._id, row]));
  const results = [...candidates.values()].map(({ artist, rank, match }) => ({
    rank,
    artistId: artist.artistId,
    name: artist.name,
    match,
    releaseCount: statsById.get(artist.artistId)?.count || 0,
    knownFor: statsById.get(artist.artistId)?.titles || [],
  }));
  results.sort((first, second) => first.rank - second.rank
    || second.releaseCount - first.releaseCount
    || first.name.localeCompare(second.name)
    || (first.artistId < second.artistId ? -1 : 1));
  return { results: results.slice(0, limit).map(({ rank, ...result }) => result) };
}

// Registry artists whose heading or reviewed alias is exactly the whole query.
// Album search uses these to include releases credited to the same artistId
// under another spelling or script. Partial words never expand.
async function artistIdsForExactQuery(query) {
  const normalized = String(query ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > MAX_QUERY_LENGTH) return [];
  const key = foldSearchKey(normalized);
  const mbids = REVIEWED_ARTIST_ALIASES
    .filter((entry) => entry.aliases.some((alias) => foldSearchKey(alias.name) === key))
    .map((entry) => entry.artistMbid);
  const [byName, byMbid] = await Promise.all([
    Artist.find({ name: { $regex: `^${buildRankedSearchPattern(normalized)}$`, $options: "i" } }).select("artistId").limit(CANDIDATE_LIMIT).lean(),
    loadArtistsByMbid(Artist, mbids),
  ]);
  return [...new Set([...byName, ...byMbid.values()].map((artist) => artist.artistId).filter(Boolean))];
}

// Which credited artistIds on an album have a registry artist, so the album
// page links only credits that resolve to an artist page.
async function linkedArtistIds(credits) {
  const ids = [...new Set((Array.isArray(credits) ? credits : []).map((credit) => normalizeArtistId(credit?.artistId)).filter(Boolean))];
  if (!ids.length) return [];
  const found = await loadArtistsById(Artist, ids);
  return ids.filter((id) => found.has(id));
}

module.exports = {
  MAX_RELEASE_LIMIT,
  RELEASE_FILTERS,
  RELEASE_GROUPS,
  artistDetail,
  artistIdsForExactQuery,
  artistReleases,
  foldSearchKey,
  hasOtherCreditedParty,
  linkedArtistIds,
  parseReleaseQuery,
  parseSearch,
  releaseCard,
  searchArtists,
};
