const crypto = require("node:crypto");

// Public Rescened artist identity. Like albumId, artistId is a random UUID v4
// and is never derived from an upstream provider ID. MusicBrainz artist MBIDs
// are kept beside it, on album credits and as registry external references.
const ARTIST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIST_SOURCES = ["import", "community", "manual"];
const MAX_ARTIST_NAME_LENGTH = 500;

class ArtistIdentityError extends Error {
  constructor(message, code = "ARTIST_IDENTITY_CONFLICT", details = []) {
    super(message);
    this.name = "ArtistIdentityError";
    this.code = code;
    this.details = details;
  }
}

function normalizeArtistMbid(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return MBID_PATTERN.test(normalized) ? normalized : "";
}

function normalizeArtistId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ARTIST_ID_PATTERN.test(normalized) ? normalized : "";
}

function isArtistId(value) {
  return typeof value === "string" && ARTIST_ID_PATTERN.test(value.trim());
}

function plain(value) {
  if (value && typeof value.toObject === "function") return value.toObject({ depopulate: true, versionKey: false });
  return value || {};
}

function musicBrainzArtistReference(artistMbid) {
  const mbid = normalizeArtistMbid(artistMbid);
  if (!mbid) throw new ArtistIdentityError("A valid MusicBrainz artist MBID is required", "INVALID_ARTIST_MBID");
  return {
    provider: "musicbrainz",
    entityType: "artist",
    externalId: mbid,
    url: `https://musicbrainz.org/artist/${mbid}`,
  };
}

// The registry stores at most one MusicBrainz artist reference per artist.
function artistMbidOf(artist) {
  const reference = (plain(artist).externalReferences || []).find((candidate) => (
    String(candidate?.provider || "").toLowerCase() === "musicbrainz"
    && String(candidate?.entityType || "").toLowerCase() === "artist"
  ));
  return normalizeArtistMbid(reference?.externalId);
}

function artistMbidQuery(mbids) {
  return {
    externalReferences: {
      $elemMatch: { provider: "musicbrainz", entityType: "artist", externalId: { $in: [...mbids] } },
    },
  };
}

// Canonical credit shape. Key order matches the AlbumCatalog credit schema so
// that JSON comparisons of stored and normalized credits stay stable. Identity
// keys are omitted, not blanked, when a credit has no established identity.
function creditWithIdentity(credit, identity = {}) {
  const result = { name: credit.name, role: credit.role || "main" };
  const artistId = normalizeArtistId(identity.artistId);
  const artistMbid = normalizeArtistMbid(identity.artistMbid);
  if (artistId) result.artistId = artistId;
  if (artistMbid) result.artistMbid = artistMbid;
  return result;
}

function creditIdentity(credit) {
  return {
    artistId: normalizeArtistId(credit?.artistId),
    artistMbid: normalizeArtistMbid(credit?.artistMbid),
  };
}

function creditsHaveIdentity(credits) {
  return (Array.isArray(credits) ? credits : []).some((credit) => {
    const identity = creditIdentity(credit);
    return Boolean(identity.artistId || identity.artistMbid);
  });
}

// Internal provider metadata only. Contributor-supplied credit names are
// display text and must never be treated as canonical artist metadata.
function normalizeArtistName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ARTIST_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ArtistIdentityError("A valid canonical artist name is required", "INVALID_ARTIST_NAME");
  }
  return value.normalize("NFC").trim();
}

function newArtistDocument({ name, artistName, artistMbid, source, provenance = {}, artistId = crypto.randomUUID() }) {
  const trimmedName = artistName === undefined ? String(name || "").trim() : normalizeArtistName(artistName);
  if (!trimmedName) throw new ArtistIdentityError("An artist name is required", "INVALID_ARTIST_NAME");
  if (!ARTIST_SOURCES.includes(source)) throw new ArtistIdentityError(`Unknown artist source: ${source}`, "INVALID_ARTIST_SOURCE");
  const normalizedId = normalizeArtistId(artistId);
  if (!normalizedId) throw new ArtistIdentityError("artistId must be a UUID v4", "INVALID_ARTIST_ID");
  return {
    artistId: normalizedId,
    name: trimmedName.slice(0, MAX_ARTIST_NAME_LENGTH),
    externalReferences: [musicBrainzArtistReference(artistMbid)],
    fieldProvenance: {
      name: { ...provenance, nameSource: artistName === undefined ? "artist-credit" : "musicbrainz-artist", ...(artistName === undefined ? {} : { artistMbid: normalizeArtistMbid(artistMbid) }) },
      externalReferences: { ...provenance },
    },
    artistSource: source,
  };
}

function withSession(query, session) {
  if (session && query && typeof query.session === "function") return query.session(session);
  return query;
}

async function resolveQuery(query, session) {
  let resolved = withSession(query, session);
  if (resolved && typeof resolved.lean === "function") resolved = resolved.lean();
  if (resolved && typeof resolved.exec === "function") resolved = resolved.exec();
  return (await resolved) || [];
}

async function loadArtistsByMbid(Artist, mbids, { session } = {}) {
  const wanted = [...new Set([...mbids].map(normalizeArtistMbid).filter(Boolean))];
  const result = new Map();
  if (!wanted.length) return result;
  const rows = await resolveQuery(Artist.find(artistMbidQuery(wanted)), session);
  for (const row of rows) {
    const mbid = artistMbidOf(row);
    if (!mbid || !wanted.includes(mbid)) continue;
    if (result.has(mbid) && result.get(mbid).artistId !== plain(row).artistId) {
      throw new ArtistIdentityError(
        `More than one artist claims MusicBrainz artist ${mbid}`,
        "ARTIST_REGISTRY_CONFLICT",
        [{ artistMbid: mbid }],
      );
    }
    result.set(mbid, plain(row));
  }
  return result;
}

async function loadArtistsById(Artist, artistIds, { session } = {}) {
  const wanted = [...new Set([...artistIds].map(normalizeArtistId).filter(Boolean))];
  const result = new Map();
  if (!wanted.length) return result;
  const rows = await resolveQuery(Artist.find({ artistId: { $in: wanted } }), session);
  for (const row of rows) result.set(plain(row).artistId, plain(row));
  return result;
}

// Checks credit identities against the registry without writing. A credit may
// name an existing artistId, a MusicBrainz artist MBID, both, or neither. An
// MBID the registry does not know yet is not a problem; approval registers it.
// Name-only credits stay unlinked: identity is never inferred from a name.
function creditIdentityProblems(credits, { byId }) {
  const problems = [];
  (credits || []).forEach((credit, index) => {
    const { artistId, artistMbid } = creditIdentity(credit);
    if (!artistId) return;
    const artist = byId.get(artistId);
    if (!artist) {
      problems.push({ index, code: "ARTIST_NOT_FOUND", artistId });
      return;
    }
    const registeredMbid = artistMbidOf(artist);
    if (artistMbid && registeredMbid !== artistMbid) {
      problems.push({ index, code: "ARTIST_MBID_MISMATCH", artistId, artistMbid, registeredMbid: registeredMbid || null });
    }
  });
  return problems;
}

async function findCreditIdentityProblems(credits, { Artist, session } = {}) {
  if (!creditsHaveIdentity(credits)) return [];
  const identities = (credits || []).map(creditIdentity);
  const byId = await loadArtistsById(Artist, identities.map((identity) => identity.artistId), { session });
  return creditIdentityProblems(credits, { byId });
}

// Resolves every credit to a registry identity inside the caller's
// transaction, registering an artist for each MusicBrainz MBID the registry
// does not know yet. Throws ArtistIdentityError rather than guessing when a
// supplied artistId is unknown or disagrees with its registered MBID.
async function resolveCreditIdentities(credits, { Artist, session, source, provenance = {} } = {}) {
  const list = Array.isArray(credits) ? credits : [];
  if (!creditsHaveIdentity(list)) {
    return { credits: list.map((credit) => creditWithIdentity(credit)), createdArtists: [] };
  }
  const identities = list.map(creditIdentity);
  const byId = await loadArtistsById(Artist, identities.map((identity) => identity.artistId), { session });
  const byMbid = await loadArtistsByMbid(Artist, identities.map((identity) => identity.artistMbid), { session });
  const problems = creditIdentityProblems(list, { byId });
  if (problems.length) {
    throw new ArtistIdentityError("An artist credit does not match the artist registry", "ARTIST_IDENTITY_CONFLICT", problems);
  }

  const created = new Map();
  const resolved = list.map((credit, index) => {
    const { artistId, artistMbid } = identities[index];
    if (artistId) {
      return creditWithIdentity(credit, { artistId, artistMbid: artistMbidOf(byId.get(artistId)) });
    }
    if (!artistMbid) return creditWithIdentity(credit);
    const existing = byMbid.get(artistMbid) || created.get(artistMbid);
    if (existing) return creditWithIdentity(credit, { artistId: existing.artistId, artistMbid });
    const document = newArtistDocument({ name: credit.name, artistMbid, source, provenance });
    created.set(artistMbid, document);
    return creditWithIdentity(credit, { artistId: document.artistId, artistMbid });
  });

  const createdArtists = [...created.values()];
  if (createdArtists.length) {
    try {
      await Artist.create(createdArtists, { session, ordered: true });
    } catch (error) {
      if (error?.code === 11000) {
        throw new ArtistIdentityError(
          "Another change registered one of these MusicBrainz artists at the same time; retry",
          "ARTIST_IDENTITY_CONFLICT",
          createdArtists.map((artist) => ({ code: "ARTIST_REGISTRATION_RACE", artistMbid: artistMbidOf(artist) })),
        );
      }
      throw error;
    }
  }
  return { credits: resolved, createdArtists };
}

module.exports = {
  ARTIST_ID_PATTERN,
  ARTIST_SOURCES,
  ArtistIdentityError,
  MAX_ARTIST_NAME_LENGTH,
  MBID_PATTERN,
  artistMbidOf,
  artistMbidQuery,
  creditIdentity,
  creditWithIdentity,
  creditsHaveIdentity,
  findCreditIdentityProblems,
  isArtistId,
  loadArtistsById,
  loadArtistsByMbid,
  musicBrainzArtistReference,
  newArtistDocument,
  normalizeArtistId,
  normalizeArtistMbid,
  normalizeArtistName,
  resolveCreditIdentities,
};
