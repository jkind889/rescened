// SYNTHETIC in-memory API for the artist suggestions preview
// (scripts/artistSuggestionsPreview.cjs). It runs in the browser page and
// answers the artist picker and artist suggestion endpoints with fixture
// data. No server, database, sign-in, or MusicBrainz is involved, and it is
// not a model of production behavior beyond the request/response shapes and
// the main guards (revision checks, request-key replay, exact-MBID reuse).

const LOCAL_ARTISTS = [
  { artistId: "11111111-1111-4111-8111-111111111111", name: "Nova", artistMbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711", releaseCount: 3, knownFor: ["Night Drive", "Glass"] },
  { artistId: "22222222-2222-4222-8222-222222222222", name: "Nova", artistMbid: "", releaseCount: 0, knownFor: [] },
  { artistId: "33333333-3333-4333-8333-333333333333", name: "Tyler, the Creator", artistMbid: "", releaseCount: 2, knownFor: ["Igor"] },
];

const MUSICBRAINZ_ARTISTS = [
  { artistMbid: "a74b1b7f-71a5-4011-9441-d0b5e4122711", name: "Nova", disambiguation: "UK synth-pop band", type: "Group", country: "GB" },
  { artistMbid: "83096042-3785-481e-8843-dee69f1aad12", name: "Nova", disambiguation: "US rapper", type: "Person", country: "US" },
  { artistMbid: "e941e097-0f9e-496d-a381-dd74a953682c", name: "Echo Lake", disambiguation: "London dream-pop band", type: "Group", country: "GB" },
];

function fold(value) {
  return String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function uuid(counter) {
  const hex = counter.toString(16).padStart(12, "0");
  return `9${hex.slice(0, 7)}-0000-4000-8000-${hex}`.slice(0, 36);
}

export function createFakeApi({ now = () => new Date() } = {}) {
  let counter = 0;
  const artists = LOCAL_ARTISTS.map((artist) => ({ ...artist }));
  const suggestions = [];
  const keys = new Map();
  const nextId = () => uuid(++counter);

  const reply = (status, body) => ({ status, body });
  const error = (status, message, code, extra = {}) => reply(status, { error: message, code, ...extra });

  function summary(row, detail = false) {
    const { evidence, ...proposal } = row.proposal;
    return {
      submissionId: row.submissionId,
      submittedByUserId: row.submittedByUserId,
      status: row.status,
      currentRevision: row.currentRevision,
      proposal: detail ? row.proposal : proposal,
      ...(row.approvedArtistId ? { approvedArtistId: row.approvedArtistId, approvalOutcome: row.approvalOutcome } : {}),
      ...(row.duplicateOfArtistId ? { duplicateOfArtistId: row.duplicateOfArtistId } : {}),
      ...(detail ? { note: row.note, moderationHistory: row.history } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function prepare(input) {
    if (!input || typeof input !== "object") return { problem: error(400, "artistProposal is required", "INVALID_ARTIST_SUGGESTION") };
    if (input.kind === "musicbrainz") {
      const observed = MUSICBRAINZ_ARTISTS.find((artist) => artist.artistMbid === input.artistMbid);
      if (!observed) return { problem: error(400, "The selected MusicBrainz artist was not found", "ARTIST_MBID_NOT_FOUND") };
      const existing = artists.find((artist) => artist.artistMbid === input.artistMbid);
      if (existing) return { problem: error(409, "This MusicBrainz artist is already on Rescened", "ARTIST_ALREADY_EXISTS", { existingArtist: { artistId: existing.artistId, name: existing.name } }) };
      return { proposal: { proposalKey: "artist", kind: "musicbrainz", artistMbid: input.artistMbid, observation: { ...observed, sortName: "", observedAt: now().toISOString() } } };
    }
    if (input.kind === "community" && String(input.canonicalName || "").trim() && Array.isArray(input.evidence) && input.evidence.length) {
      return { proposal: { proposalKey: "artist", kind: "community", canonicalName: input.canonicalName.trim(), evidence: input.evidence.map((entry) => ({ url: entry.url, description: "" })) } };
    }
    return { problem: error(400, "Choose a MusicBrainz artist or propose a community artist with links", "INVALID_ARTIST_PROPOSAL") };
  }

  function event(row, actorUserId, action, reason = "") {
    row.history.push({ actorUserId, action, reason, revision: row.currentRevision, createdAt: now().toISOString() });
    row.updatedAt = now().toISOString();
  }

  function find(id) {
    return suggestions.find((row) => row.submissionId === id);
  }

  function discovery(path, query) {
    const q = fold(query.get("q"));
    if (path.endsWith("/local")) {
      return reply(200, { query: query.get("q") || "", results: q ? artists.filter((artist) => fold(artist.name).includes(q)).map((artist) => ({ ...artist, match: null })) : [] });
    }
    const candidates = MUSICBRAINZ_ARTISTS.filter((artist) => fold(artist.name).includes(q)).map((artist) => {
      const registered = artists.find((local) => local.artistMbid === artist.artistMbid);
      return { kind: "external", provider: "musicbrainz", ...artist, sortName: "", registeredArtistId: registered?.artistId || null, registeredName: registered?.name || null, sourceUrl: `https://musicbrainz.org/artist/${artist.artistMbid}` };
    });
    return reply(200, { query: query.get("q") || "", provider: "musicbrainz", candidates });
  }

  function contributor(method, path, query, body, userId) {
    const parts = path.split("/").filter(Boolean); // ["artist-suggestions", id?, action?]
    if (method === "GET" && parts[1] === "mine") {
      const mine = suggestions.filter((row) => row.submittedByUserId === userId).slice().reverse();
      const start = Number(query.get("cursor") || 0);
      const page = mine.slice(start, start + 20);
      return reply(200, { suggestions: page.map((row) => summary(row)), nextCursor: start + 20 < mine.length ? String(start + 20) : null });
    }
    if (method === "POST" && parts.length === 1) {
      const fingerprint = JSON.stringify([body?.artistProposal, String(body?.note || "").trim()]);
      const saved = keys.get(`${userId}:${body?.requestKey}`);
      if (saved) return saved.fingerprint === fingerprint ? reply(200, { ...summary(find(saved.id), true), idempotent: true }) : error(409, "This request key was already used for a different suggestion", "REQUEST_KEY_CONFLICT");
      if (!body?.requestKey) return error(400, "requestKey is required", "INVALID_REQUEST_KEY");
      const { proposal, problem } = prepare(body.artistProposal);
      if (problem) return problem;
      const at = now().toISOString();
      const row = { submissionId: nextId(), submittedByUserId: userId, status: "pending", currentRevision: 1, proposal, note: String(body.note || "").trim(), history: [], createdAt: at, updatedAt: at };
      event(row, userId, "submitted");
      suggestions.push(row);
      keys.set(`${userId}:${body.requestKey}`, { fingerprint, id: row.submissionId });
      return reply(201, summary(row, true));
    }
    const row = find(parts[1]);
    if (!row || row.submittedByUserId !== userId) return error(404, "Artist suggestion not found", "ARTIST_SUGGESTION_NOT_FOUND");
    if (method === "GET" && parts.length === 2) return reply(200, summary(row, true));
    if (!Number.isInteger(body?.expectedRevision)) return error(400, "expectedRevision must name the revision you reviewed", "EXPECTED_REVISION_REQUIRED");
    if (parts[2] === "revise") {
      if (row.status !== "needs_changes") return error(409, "Only artist suggestions needing changes can be revised", "INVALID_SUBMISSION_STATE");
      if (row.currentRevision !== body.expectedRevision) return error(409, "The artist suggestion changed since you last loaded it", "REVISION_CONFLICT");
      const { proposal, problem } = prepare(body.artistProposal);
      if (problem) return problem;
      Object.assign(row, { proposal, note: String(body.note || "").trim(), status: "pending", currentRevision: row.currentRevision + 1 });
      event(row, userId, "revised");
      return reply(200, summary(row, true));
    }
    if (parts[2] === "withdraw") {
      if (!["pending", "needs_changes"].includes(row.status)) return error(409, "Only active artist suggestions can be withdrawn", "INVALID_SUBMISSION_STATE");
      if (row.currentRevision !== body.expectedRevision) return error(409, "The artist suggestion changed since you last loaded it", "STATE_CONFLICT");
      row.status = "withdrawn";
      event(row, userId, "withdrawn");
      return reply(200, summary(row, true));
    }
    return error(404, "Not found", "NOT_FOUND");
  }

  function context(row) {
    const name = row.proposal.kind === "community" ? row.proposal.canonicalName : row.proposal.observation.name;
    const registered = row.proposal.kind === "musicbrainz" ? artists.find((artist) => artist.artistMbid === row.proposal.artistMbid) : null;
    return {
      registeredArtist: registered ? { artistId: registered.artistId, name: registered.name } : null,
      sameNameArtists: artists.filter((artist) => fold(artist.name) === fold(name)).map((artist) => ({ artistId: artist.artistId, name: artist.name, releaseCount: artist.releaseCount })),
    };
  }

  function moderation(method, path, query, body, userId) {
    const parts = path.split("/").filter(Boolean); // ["moderation", "artist-suggestions", id?, action?]
    if (method === "GET" && parts.length === 2) {
      const statuses = (query.get("status") || "pending").split(",");
      return reply(200, { suggestions: suggestions.filter((row) => statuses.includes(row.status)).map((row) => summary(row)), nextCursor: null });
    }
    const row = find(parts[2]);
    if (!row) return error(404, "Artist suggestion not found", "ARTIST_SUGGESTION_NOT_FOUND");
    if (method === "GET") return reply(200, { suggestion: summary(row, true), context: context(row) });
    if (!Number.isInteger(body?.expectedRevision)) return error(400, "expectedRevision must name the revision you reviewed", "EXPECTED_REVISION_REQUIRED");
    if (row.status !== "pending") return error(409, "Only pending artist suggestions can be moderated", "INVALID_SUBMISSION_STATE");
    if (row.currentRevision !== body.expectedRevision) return error(409, "The artist suggestion changed since you last loaded it", "STATE_CONFLICT");
    const action = parts[3];
    if (["request-changes", "reject"].includes(action) && !String(body.reason || "").trim()) return error(400, "reason is required", "INVALID_MODERATION_REQUEST");
    if (action === "approve") {
      const existing = row.proposal.kind === "musicbrainz" ? artists.find((artist) => artist.artistMbid === row.proposal.artistMbid) : null;
      const artist = existing || { artistId: nextId(), name: row.proposal.kind === "community" ? row.proposal.canonicalName : row.proposal.observation.name, artistMbid: row.proposal.artistMbid || "", releaseCount: 0, knownFor: [] };
      if (!existing) artists.push(artist);
      Object.assign(row, { status: "approved", approvedArtistId: artist.artistId, approvalOutcome: existing ? "reused" : "created" });
      event(row, userId, "approved", body.reason || "");
    } else if (action === "request-changes") {
      row.status = "needs_changes";
      event(row, userId, "request_changes", body.reason);
    } else if (action === "reject") {
      row.status = "rejected";
      event(row, userId, "rejected", body.reason);
    } else if (action === "mark-duplicate") {
      const target = artists.find((artist) => artist.artistId === body.duplicateOfArtistId);
      if (!target) return error(409, "duplicateOfArtistId must name an artist on Rescened", "INVALID_DUPLICATE_TARGET");
      Object.assign(row, { status: "duplicate", duplicateOfArtistId: target.artistId });
      event(row, userId, "marked_duplicate", body.reason || "Already on Rescened.");
    } else {
      return error(404, "Not found", "NOT_FOUND");
    }
    return reply(200, { suggestion: summary(row, true), context: context(row) });
  }

  // handle(method, url, body, userId) -> { status, body }
  function handle(method, rawUrl, body = undefined, userId = "user_preview") {
    const url = new URL(rawUrl, "http://preview.invalid");
    const path = url.pathname;
    if (path === "/artist-discovery/capabilities") return reply(200, { enabled: true });
    if (path === "/moderation/album-suggestions/access") return reply(200, { moderator: true });
    if (path.startsWith("/artist-discovery/")) return discovery(path, url.searchParams);
    if (path.startsWith("/artist-suggestions")) return contributor(method, path, url.searchParams, body, userId);
    if (path.startsWith("/moderation/artist-suggestions")) return moderation(method, path, url.searchParams, body, userId);
    if (path.endsWith("/capabilities")) return reply(200, { enabled: false });
    return error(503, "Not part of the synthetic preview", "SYNTHETIC_PREVIEW");
  }

  return { handle, state: () => ({ artists: artists.map((artist) => ({ ...artist })), suggestions: suggestions.map((row) => ({ ...row })) }) };
}
