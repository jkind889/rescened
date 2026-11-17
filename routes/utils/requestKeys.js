const crypto = require("node:crypto");

// Durable protection for ambiguous create retries. A contributor's client
// sends a random UUID v4 `requestKey` with a create; the server stores it with
// a digest of the normalized client payload under a unique
// (submittedByUserId, creationRequestKey) index. Retrying the same key with
// the same payload returns the original record; the same key with different
// content is a conflict. A disabled button is not a substitute for this.
//
// The digest must cover the normalized client input, not server-prepared
// data such as provider observations, which can differ between attempts.

const REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RequestKeyValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequestKeyValidationError";
    this.status = 400;
    this.code = "INVALID_REQUEST_KEY";
    this.details = [message];
  }
}

class RequestKeyConflictError extends Error {
  constructor(message = "This request key was already used for a different suggestion") {
    super(message);
    this.name = "RequestKeyConflictError";
    this.status = 409;
    this.code = "REQUEST_KEY_CONFLICT";
  }
}

function normalizeRequestKey(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RequestKeyValidationError("requestKey is required");
    return "";
  }
  if (typeof value !== "string" || !REQUEST_KEY_PATTERN.test(value.trim())) {
    throw new RequestKeyValidationError("requestKey must be a UUID v4");
  }
  return value.trim().toLowerCase();
}

// JSON with object keys sorted at every level, so logically equal payloads
// digest the same regardless of key order. Arrays keep their order.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function payloadDigest(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isRequestKeyCollision(error) {
  if (error?.code !== 11000) return false;
  const keys = Object.keys(error.keyPattern || error.keyValue || {});
  return keys.includes("creationRequestKey");
}

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

async function findByRequestKey(Model, userId, requestKey) {
  let query = Model.findOne({ submittedByUserId: userId, creationRequestKey: requestKey });
  if (query && typeof query.exec === "function") query = query.exec();
  return query;
}

function matchExisting(existing, digest) {
  if (plain(existing)?.creationPayloadDigest !== digest) throw new RequestKeyConflictError();
  return { document: existing, idempotent: true };
}

// Runs `create` unless this user already created a record with the key.
// `create` must persist `creationRequestKey` and `creationPayloadDigest`
// (see requestKeyFields) and may run its own transaction; a unique-index
// collision from a concurrent attempt is resolved by re-reading after the
// failed attempt has fully aborted.
async function createWithRequestKey({ Model, userId, requestKey, digest, create }) {
  if (!requestKey) return { document: await create(), idempotent: false };
  const existing = await findByRequestKey(Model, userId, requestKey);
  if (existing) return matchExisting(existing, digest);
  try {
    return { document: await create(), idempotent: false };
  } catch (error) {
    if (!isRequestKeyCollision(error)) throw error;
    const winner = await findByRequestKey(Model, userId, requestKey);
    if (!winner) throw error;
    return matchExisting(winner, digest);
  }
}

function requestKeyFields(requestKey, digest) {
  return requestKey ? { creationRequestKey: requestKey, creationPayloadDigest: digest } : {};
}

module.exports = {
  REQUEST_KEY_PATTERN,
  RequestKeyConflictError,
  RequestKeyValidationError,
  canonicalJson,
  createWithRequestKey,
  isRequestKeyCollision,
  normalizeRequestKey,
  payloadDigest,
  requestKeyFields,
};
