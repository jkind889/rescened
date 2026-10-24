const AlbumCatalog = require("../../models/AlbumCatalog");
const UserProfile = require("../../models/UserProfile");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { fail, uuid } = require("./diaryValidation");

const MAX_QUEUE = 15;
const QUEUE_PREVIEW = 3;
const WRITE_ATTEMPTS = 3;
const POSITIONS = new Set(["top", "bottom"]);

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function catalogId(value) { return value?._id || value; }
function sameId(left, right) { return String(catalogId(left)) === String(catalogId(right)); }
function invalid(message) { return fail(400, "INVALID_QUEUE_REQUEST", message); }
function changed() { return fail(409, "QUEUE_CHANGED", "Your queue changed somewhere else. Refresh and try again."); }

function queueRevision(profile) { return Number(plain(profile)?.queueRevision) || 0; }

// Until the first queue write, the legacy single "listening next" album is the
// queue. Every queue write materializes it and clears the legacy field, so no
// migration step is needed.
function effectiveQueue(profile) {
  const source = plain(profile) || {};
  if (queueRevision(source) > 0) {
    return (source.listenQueue || []).map((entry) => ({ albumCatalogId: catalogId(entry.albumCatalogId), addedAt: entry.addedAt }));
  }
  const legacy = source.listeningNextAlbum?.albumCatalogId;
  return legacy ? [{ albumCatalogId: catalogId(legacy), addedAt: source.updatedAt || new Date() }] : [];
}

function bodyFields(body, allowed, required) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !allowed.includes(key))
      || required.some((key) => !(key in body))) {
    throw invalid("Request contains invalid or unsupported fields");
  }
}

// Without a position, an album is added at the bottom, and an album that is
// already queued stays where it is. An explicit top or bottom moves it.
function addInput(body) {
  bodyFields(body, ["albumId", "position"], ["albumId"]);
  if (body.position !== undefined && !POSITIONS.has(body.position)) throw invalid("position must be top or bottom");
  return { albumId: uuid(body.albumId, "album"), position: body.position || null };
}

function reorderInput(body) {
  bodyFields(body, ["albumIds", "revision"], ["albumIds", "revision"]);
  if (!Array.isArray(body.albumIds) || body.albumIds.length > MAX_QUEUE) throw invalid(`albumIds must be a list of at most ${MAX_QUEUE} albums`);
  if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw invalid("revision must be a non-negative integer");
  const albumIds = body.albumIds.map((id) => uuid(id, "album"));
  if (new Set(albumIds).size !== albumIds.length) throw invalid("albumIds must not repeat an album");
  return { albumIds, revision: body.revision };
}

// Returns a new array with albumCatalogId placed at the top or bottom. An album
// that is already queued moves and keeps its original addedAt; with no position
// it stays where it is.
function placeAlbum(entries, albumCatalogId, position, now = new Date()) {
  const existing = entries.find((entry) => sameId(entry.albumCatalogId, albumCatalogId));
  if (existing && !position) return entries;
  const rest = entries.filter((entry) => entry !== existing);
  if (!existing && rest.length >= MAX_QUEUE) throw fail(409, "QUEUE_FULL", `Your queue can hold ${MAX_QUEUE} albums. Remove one first.`);
  const entry = existing || { albumCatalogId, addedAt: now };
  return position === "top" ? [entry, ...rest] : [...rest, entry];
}

// The requested order must name exactly the queue's current albums, so a
// reorder drawn from a stale copy never drops or resurrects an album.
function applyOrder(entries, orderedCatalogIds) {
  if (orderedCatalogIds.length !== entries.length) throw changed();
  const byId = new Map(entries.map((entry) => [String(entry.albumCatalogId), entry]));
  const next = orderedCatalogIds.map((id) => byId.get(String(id)));
  if (next.some((entry) => !entry)) throw changed();
  return next;
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((entry, index) => sameId(entry.albumCatalogId, right[index].albumCatalogId));
}

async function ensureProfile(userId) {
  await UserProfile.updateOne({ userId }, { $setOnInsert: { userId } }, { upsert: true });
}

async function loadProfile(userId) {
  return UserProfile.findOne({ userId }).select("userId listenQueue queueRevision listeningNextAlbum updatedAt").lean();
}

// A conditional write on queueRevision: a concurrent change makes it match
// nothing instead of overwriting. Writing always clears the legacy field.
async function writeQueue(userId, revision, entries) {
  const filter = revision > 0 ? { userId, queueRevision: revision } : { userId, queueRevision: { $not: { $gt: 0 } } };
  const result = await UserProfile.updateOne(filter, {
    $set: {
      listenQueue: entries.map((entry) => ({ albumCatalogId: catalogId(entry.albumCatalogId), addedAt: entry.addedAt })),
      queueRevision: revision + 1,
      listeningNextAlbum: null,
    },
  });
  return result.matchedCount === 1;
}

// Entries whose catalog album no longer resolves are dropped from reads and
// from the next write.
async function resolveAlbums(entries) {
  if (!entries.length) return new Map();
  const albums = await AlbumCatalog.find({ _id: { $in: entries.map((entry) => entry.albumCatalogId) } });
  return new Map(albums.map((album) => [String(album._id), album]));
}

function serializeQueue(entries, albums, { revision, limit } = {}) {
  const items = entries
    .map((entry) => {
      const album = albums.get(String(entry.albumCatalogId));
      const normalized = album ? normalizeCatalogAlbum(album) : null;
      return normalized?.albumId ? { ...normalized, addedAt: entry.addedAt } : null;
    })
    .filter(Boolean);
  const albumsOut = limit ? items.slice(0, limit) : items;
  return { albums: albumsOut, count: items.length, limit: MAX_QUEUE, ...(revision === undefined ? {} : { revision }) };
}

async function readQueue(userId, { includeRevision = false, limit } = {}) {
  const profile = await loadProfile(userId);
  const entries = effectiveQueue(profile);
  const albums = await resolveAlbums(entries);
  return serializeQueue(entries, albums, { revision: includeRevision ? queueRevision(profile) : undefined, limit });
}

// The profile preview: the first few queued albums and the total.
async function queuePreview(profile) {
  const entries = effectiveQueue(profile);
  const albums = await resolveAlbums(entries);
  const { albums: upNext, count } = serializeQueue(entries, albums, { limit: QUEUE_PREVIEW });
  return { upNext, queueCount: count };
}

async function mutateQueue(userId, change) {
  await ensureProfile(userId);
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const profile = await loadProfile(userId);
    const revision = queueRevision(profile);
    const current = effectiveQueue(profile);
    const albums = await resolveAlbums(current);
    const visible = current.filter((entry) => albums.has(String(entry.albumCatalogId)));
    const next = change(visible);
    if (sameOrder(next, current)) return readQueue(userId, { includeRevision: true });
    if (await writeQueue(userId, revision, next)) return readQueue(userId, { includeRevision: true });
  }
  throw changed();
}

async function addToQueue(userId, body) {
  const input = addInput(body);
  const album = await AlbumCatalog.findOne({ albumId: input.albumId }).select("_id");
  if (!album) throw fail(404, "ALBUM_NOT_FOUND", "Catalog album not found");
  return mutateQueue(userId, (entries) => placeAlbum(entries, album._id, input.position));
}

async function removeFromQueue(userId, albumIdValue) {
  const albumId = uuid(albumIdValue, "album");
  const album = await AlbumCatalog.findOne({ albumId }).select("_id");
  if (!album) return readQueue(userId, { includeRevision: true });
  return mutateQueue(userId, (entries) => entries.filter((entry) => !sameId(entry.albumCatalogId, album._id)));
}

// A reorder carries the revision the client last read, so a reorder from a
// stale tab returns 409 instead of retrying over someone else's change.
async function reorderQueue(userId, body) {
  const input = reorderInput(body);
  await ensureProfile(userId);
  const profile = await loadProfile(userId);
  const revision = queueRevision(profile);
  if (input.revision !== revision) throw changed();
  const current = effectiveQueue(profile);
  const albums = await resolveAlbums(current);
  const visible = current.filter((entry) => albums.has(String(entry.albumCatalogId)));
  const publicToCatalog = new Map([...albums.values()].map((album) => [album.albumId, album._id]));
  const next = applyOrder(visible, input.albumIds.map((albumId) => publicToCatalog.get(albumId) || albumId));
  if (!(await writeQueue(userId, revision, next))) throw changed();
  return readQueue(userId, { includeRevision: true });
}

// Called inside the transaction that creates a listen, manual or automatic, so
// the listen and the queue change commit together.
async function removeListenedAlbum(userId, albumCatalogId, session) {
  await UserProfile.updateOne(
    { userId, queueRevision: { $gt: 0 }, "listenQueue.albumCatalogId": albumCatalogId },
    { $pull: { listenQueue: { albumCatalogId } }, $inc: { queueRevision: 1 } },
    { session },
  );
  await UserProfile.updateOne(
    { userId, queueRevision: { $not: { $gt: 0 } }, "listeningNextAlbum.albumCatalogId": albumCatalogId },
    { $set: { listenQueue: [], queueRevision: 1, listeningNextAlbum: null } },
    { session },
  );
}

module.exports = {
  MAX_QUEUE,
  QUEUE_PREVIEW,
  addInput,
  addToQueue,
  applyOrder,
  effectiveQueue,
  placeAlbum,
  queuePreview,
  readQueue,
  removeFromQueue,
  removeListenedAlbum,
  reorderInput,
  reorderQueue,
};
