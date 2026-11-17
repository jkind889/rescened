// Artist credit identity for the suggestion and correction forms. A credit
// carries a proposed identity (a Rescened artistId and/or a MusicBrainz
// artistMbid) only while its name is unchanged. Renaming a credit submits a
// plain, unlinked credit instead of guessing. The server validates and
// resolves every identity; these helpers only avoid dropping one by accident.

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function creditIdentity(credit) {
  const artistId = typeof credit?.artistId === "string" ? credit.artistId.trim() : "";
  const artistMbid = typeof credit?.artistMbid === "string" ? credit.artistMbid.trim() : "";
  if (!artistId && !artistMbid) return null;
  return { name: String(credit?.name || "").trim(), artistId, artistMbid };
}

export function creditPayload(name, role, identity) {
  const credit = { name, role };
  if (identity && identity.name === name) {
    if (identity.artistId) credit.artistId = identity.artistId;
    if (identity.artistMbid) credit.artistMbid = identity.artistMbid;
  }
  return credit;
}

// Moderator review: whether a credit's wording differs from the registry name
// of the artist its artistId links to. Differences can be legitimate
// ("credited as"), so this only draws attention; it never blocks.
function foldName(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function registryNameDiffers(creditName, registryName) {
  return Boolean(foldName(registryName)) && foldName(creditName) !== foldName(registryName);
}

export function musicBrainzArtistUrl(identity) {
  return identity?.artistMbid && MBID.test(identity.artistMbid)
    ? `https://musicbrainz.org/artist/${identity.artistMbid.toLowerCase()}`
    : "";
}

// Editable credit rows for the correction form. Each row is one structured
// credit ({ key, name, role, identity }), so a name containing a comma, such as
// "Tyler, The Creator", is never split. The row's identity travels with it and
// is submitted only while the name is unchanged (see creditPayload).
// The catalog has no limit on credits, but a correction can carry at most this
// many. Loading never truncates: a longer album keeps every row and the form
// reports the limit (creditRowProblems) instead of silently dropping credits.
export const MAX_CREDIT_ROWS = 20;

let fallbackRowKey = 0;

function newRowKey() {
  if (globalThis.crypto?.randomUUID) return `credit-${globalThis.crypto.randomUUID()}`;
  fallbackRowKey += 1;
  return `credit-${fallbackRowKey}`;
}

// Accepts a stored credit ({ name, role, artistId?, artistMbid? }), an existing
// row, or a row restored from a draft ({ name, role, identity }).
export function creditRow(value = {}) {
  const identity = value?.identity ? creditIdentity(value.identity) : creditIdentity(value);
  return {
    key: newRowKey(),
    name: typeof value?.name === "string" ? value.name : "",
    role: typeof value?.role === "string" && value.role ? value.role : "main",
    identity,
  };
}

export function creditRowsFromCredits(credits) {
  return (Array.isArray(credits) ? credits : [])
    .filter((credit) => credit && typeof credit === "object")
    .map(creditRow);
}

// Row keys are regenerated on every load, so a draft stores rows without them.
export function creditRowsSnapshot(rows) {
  return rows.map(({ name, role, identity }) => ({ name, role, identity }));
}

// Rows stored in a draft, or null when the draft has none usable. A draft from
// before credits were structured stored one comma-separated string; that text
// cannot be split reliably, so it is ignored and the current credits are used.
export function creditRowsFromDraft(value) {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((credit) => credit && typeof credit === "object" && typeof credit.name === "string")) return null;
  return value.map(creditRow);
}

// Problems that stop a correction's credits from being sent.
export function creditRowProblems(rows) {
  const problems = [];
  if (!rows.length) problems.push("Add at least one artist credit.");
  if (rows.length > MAX_CREDIT_ROWS) {
    problems.push(`A correction can carry at most ${MAX_CREDIT_ROWS} artist credits, and this form has ${rows.length}. Removing a credit here removes it from the album if approved, so deselect Artists to correct other fields instead.`);
  }
  rows.forEach((row, index) => {
    const name = row.name.trim();
    if (!name) problems.push(`Artist ${index + 1} needs a name.`);
    if (name.length > 200) problems.push(`Artist ${index + 1} name must be 200 characters or fewer.`);
    if (row.role.trim().length > 80) problems.push(`Artist ${index + 1} role must be 80 characters or fewer.`);
  });
  return problems;
}

// The structured credits to submit, in row order.
export function creditsFromRows(rows) {
  return rows.map((row) => creditPayload(row.name.trim(), row.role.trim() || "main", row.identity));
}

// Artist links on a suggestion revision (owner and moderator detail only):
// position -> { selection, proposal, resolution }. Selections name credit
// positions; proposals belong to the same revision; resolutions come from an
// approved suggestion's receipt.
export function artistLinksByPosition(source, resolutions = null) {
  const links = new Map();
  const proposals = new Map((Array.isArray(source?.artistProposals) ? source.artistProposals : [])
    .filter((proposal) => proposal?.proposalKey)
    .map((proposal) => [proposal.proposalKey, proposal]));
  for (const selection of Array.isArray(source?.artistSelections) ? source.artistSelections : []) {
    if (!Number.isInteger(selection?.position)) continue;
    links.set(selection.position, {
      selection,
      proposal: selection.kind === "proposal" ? proposals.get(selection.proposalKey) || null : null,
      resolution: null,
    });
  }
  for (const resolution of Array.isArray(resolutions) ? resolutions : []) {
    const link = links.get(resolution?.position);
    if (link) link.resolution = resolution;
  }
  return links;
}

const RESOLUTION_LABELS = { linked: "Linked to", created: "Added as", reused: "Linked to existing" };

export function resolutionLabel(resolution) {
  return RESOLUTION_LABELS[resolution?.outcome] || "Linked to";
}
