// Offline blinded adjudication of sampled review episodes (docs/DETERMINISTIC_MAPPING_METRICS_PLAN.md,
// "Moderator effort"). An export writes three private files outside the repository: a packet that
// shows the evidence without the decision, recommendation, reason or moderator; a key with the
// moderator's choice per item; and a label template. The adjudicator makes their own choice per
// item, and the report compares it with the key. Agreement is "supported", a different choice is
// "unsupported", and "insufficient" stays outside the denominator. Reviewer approval is not truth.
const crypto = require("node:crypto");
const { partition, ratio } = require("../listening/measurement");

const PACKET_VERSION = 1;
const DEFAULT_SAMPLE_SIZE = 30;
const MIN_DECISION_AGE_MS = 7 * 86_400_000;
const NO_MATCH = "no_match";
const OTHER_MATCH = "other_match";
const INSUFFICIENT = "insufficient";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
// Defer and revoke have no comparable choice, so they are not sampled.
const ADJUDICABLE = Object.freeze({ mapping: ["approved", "rejected", "no_catalog_match"], baseline: ["confirm", "replace"] });
const ADJUDICATORS = Object.freeze({ independent: "independent", same_moderator: "delayed_self_review" });

class AdjudicationError extends Error {
  constructor(code) { super(code); this.name = "AdjudicationError"; this.code = code; }
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Deterministic for a given seed, so an export can be reproduced and audited.
function seededRandom(seed) {
  let state = parseInt(sha256(String(seed)).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

const INSTRUCTIONS = [
  "For each item, decide from the evidence shown which option is the correct match, as if you were reviewing it for the first time.",
  `Answer with an option letter, "${NO_MATCH}" after independently checking the local catalog, "${OTHER_MATCH}" if that check finds an unlisted catalog album, or "${INSUFFICIENT}" when the evidence is not enough to decide.`,
  "For a mapping no-match answer, record the catalog search queries in catalogEvidence. For an unlisted match, also record its public albumId. Without this evidence, no-match answers count as insufficient.",
  "Write each answer into labels.json under the item's ID, and set \"adjudicator\" to \"independent\" or \"same_moderator\" (the moderator who made these decisions).",
  "Do not look up the decision history before labelling.",
];

// Builds the packet, key and label template for a seeded sample of recorded episodes at least seven
// days old. details resolves display text: cases (caseId -> artist/album), albums (albumId ->
// catalog fields) and targets (baseline target -> title/artist). Every option of an item is
// described from the same source, so no option stands out.
function buildPacket({ episodes, details, environment, now, seed, sampleSize = DEFAULT_SAMPLE_SIZE }) {
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 200) throw new AdjudicationError("ADJUDICATION_SAMPLE_SIZE_INVALID");
  const random = seededRandom(seed);
  const eligible = episodes.filter((episode) => episode.outcome === "recorded" && episode.evidence
    && (ADJUDICABLE[episode.kind] || []).includes(episode.action)
    && new Date(episode.decidedAt).getTime() <= now.getTime() - MIN_DECISION_AGE_MS);
  const sample = shuffle(eligible, random).slice(0, sampleSize);
  const items = []; const keyItems = [];
  for (const episode of shuffle(sample, random)) {
    const { evidence } = episode;
    const selectedId = evidence.selected?.id || "";
    // The selection stays an option even if it came from a catalog search or a direct preview.
    const ids = [...new Set([...(evidence.candidates || []).map((item) => item.id), ...(selectedId ? [selectedId] : [])])];
    const kept = ids.length > LETTERS.length ? [...ids.filter((id) => id !== selectedId).slice(0, LETTERS.length - (selectedId ? 1 : 0)), ...(selectedId ? [selectedId] : [])] : ids;
    const options = shuffle(kept, random).map((id, index) => ({ letter: LETTERS[index], id }));
    const itemId = crypto.randomUUID();
    const describe = episode.kind === "mapping"
      ? (id) => ({ ...(details.albums.get(id) || { title: "Unavailable catalog album" }), albumId: id })
      // Only previewed or recommended releases have stored details, which would point at the
      // decision, so every release option is the same bare link.
      : (id) => ({ musicBrainzUrl: `https://musicbrainz.org/release/${id}` });
    items.push({
      itemId,
      kind: episode.kind,
      prompt: episode.kind === "mapping"
        ? { task: "Which catalog album is this listened album name?", ...(details.cases.get(episode.targetId) || { artist: "", album: "" }) }
        : { task: "Which release is the standard tracklist for this album?", ...(details.targets.get(episode.targetId) || { title: "", artistDisplayName: "" }) },
      coverage: evidence.coverage || null,
      options: options.map(({ letter, id }) => ({ letter, ...describe(id) })),
    });
    const choice = selectedId ? options.find((option) => option.id === selectedId)?.letter || NO_MATCH : NO_MATCH;
    keyItems.push({ itemId, kind: episode.kind, action: episode.action, moderatorChoice: choice });
  }
  const packet = { version: PACKET_VERSION, kind: "rescened-review-adjudication-packet", environment, createdAt: now.toISOString(), instructions: INSTRUCTIONS, items };
  const packetBytes = `${JSON.stringify(packet, null, 2)}\n`;
  const packetChecksum = sha256(packetBytes);
  const key = { version: PACKET_VERSION, kind: "rescened-review-adjudication-key", packetChecksum, eligible: eligible.length, sampled: keyItems.length, items: keyItems };
  const labels = { version: PACKET_VERSION, kind: "rescened-review-adjudication-labels", packetChecksum, adjudicator: "", labels: Object.fromEntries(items.map((item) => [item.itemId, null])), catalogEvidence: Object.fromEntries(items.filter((item) => item.kind === "mapping").map((item) => [item.itemId, null])) };
  return { packetBytes, packetChecksum, keyBytes: `${JSON.stringify(key, null, 2)}\n`, labelsBytes: `${JSON.stringify(labels, null, 2)}\n`, eligible: eligible.length, sampled: items.length };
}

function parse(bytes, code) {
  try { return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); } catch { throw new AdjudicationError(code); }
}

// Joins completed labels with the key. Every file must belong to the same packet.
function summarizeLabels({ packetBytes, keyBytes, labelsBytes }) {
  const packet = parse(packetBytes, "ADJUDICATION_PACKET_INVALID");
  const key = parse(keyBytes, "ADJUDICATION_KEY_INVALID");
  const labels = parse(labelsBytes, "ADJUDICATION_LABELS_INVALID");
  const packetChecksum = sha256(packetBytes);
  if (key.packetChecksum !== packetChecksum || labels.packetChecksum !== packetChecksum) throw new AdjudicationError("ADJUDICATION_CHECKSUM_MISMATCH");
  if (!Object.hasOwn(ADJUDICATORS, labels.adjudicator)) throw new AdjudicationError("ADJUDICATION_ADJUDICATOR_REQUIRED");
  const items = new Map((packet.items || []).map((item) => [item.itemId, item]));
  const answers = labels.labels && typeof labels.labels === "object" && !Array.isArray(labels.labels) ? labels.labels : null;
  if (!answers || Object.keys(answers).some((itemId) => !items.has(itemId))) throw new AdjudicationError("ADJUDICATION_LABEL_INVALID");
  if (labels.catalogEvidence !== undefined && (!labels.catalogEvidence || typeof labels.catalogEvidence !== "object" || Array.isArray(labels.catalogEvidence))) throw new AdjudicationError("ADJUDICATION_LABEL_INVALID");
  const catalogEvidence = labels.catalogEvidence || {};
  if (Object.keys(catalogEvidence).some((itemId) => items.get(itemId)?.kind !== "mapping")) throw new AdjudicationError("ADJUDICATION_LABEL_INVALID");
  const empty = () => ({ supported: 0, unsupported: 0, insufficient: 0, unreviewed: 0 });
  const totals = empty(); const byKind = { mapping: empty(), baseline: empty() };
  for (const entry of key.items || []) {
    const item = items.get(entry.itemId);
    if (!item) throw new AdjudicationError("ADJUDICATION_KEY_INVALID");
    const answer = answers[entry.itemId] ?? null;
    const valid = answer === null || answer === NO_MATCH || (item.kind === "mapping" && answer === OTHER_MATCH) || answer === INSUFFICIENT || (item.options || []).some((option) => option.letter === answer);
    if (!valid) throw new AdjudicationError("ADJUDICATION_LABEL_INVALID");
    const proof = catalogEvidence[entry.itemId];
    const proofValid = item.kind === "mapping" && proof && typeof proof === "object" && !Array.isArray(proof)
      && Object.keys(proof).every((key) => ["queries", "matchedAlbumId"].includes(key))
      && Array.isArray(proof.queries) && proof.queries.length > 0 && proof.queries.length <= 10
      && proof.queries.every((query) => typeof query === "string" && query.trim().length >= 2 && query.length <= 200)
      && (proof.matchedAlbumId === null || (typeof proof.matchedAlbumId === "string" && UUID.test(proof.matchedAlbumId)));
    if (proof != null && !proofValid) throw new AdjudicationError("ADJUDICATION_LABEL_INVALID");
    const needsCatalogCheck = item.kind === "mapping" && [NO_MATCH, OTHER_MATCH].includes(answer);
    const checked = proofValid && (answer === OTHER_MATCH ? Boolean(proof.matchedAlbumId) : proof.matchedAlbumId === null);
    // Rejecting a case is a distinct decision from finding no catalog album. This packet
    // cannot verify the rejection reason, so a no-match answer cannot support it.
    const cannotSupportRejection = entry.action === "rejected" && answer === NO_MATCH;
    const label = answer === null ? "unreviewed" : answer === INSUFFICIENT || (needsCatalogCheck && !checked) || cannotSupportRejection
      ? "insufficient" : answer === entry.moderatorChoice ? "supported" : "unsupported";
    totals[label] += 1;
    if (byKind[entry.kind]) byKind[entry.kind][label] += 1;
  }
  const sampled = (key.items || []).length;
  const summarize = (counts, total) => ({ outcome: partition(counts, total), unsupportedRate: ratio(counts.unsupported, counts.supported + counts.unsupported, "adjudicable sampled decision") });
  return {
    collected: true,
    adjudication: ADJUDICATORS[labels.adjudicator],
    packetChecksum, keyChecksum: sha256(keyBytes), labelsChecksum: sha256(labelsBytes),
    eligibleAtExport: Number(key.eligible) || 0,
    sampled,
    ...summarize(totals, sampled),
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, counts]) => [kind, summarize(counts, Object.values(counts).reduce((sum, value) => sum + value, 0))])),
    note: "Insufficient and unreviewed items are outside the unsupported-rate denominator. A moderator's choice that differs from the adjudicator's is unsupported, not proven wrong.",
  };
}

module.exports = { ADJUDICABLE, AdjudicationError, DEFAULT_SAMPLE_SIZE, MIN_DECISION_AGE_MS, buildPacket, summarizeLabels };
