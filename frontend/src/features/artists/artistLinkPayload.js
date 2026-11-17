// Pure mapping between artist-picker selections and the suggestion request
// fields (artistProposals and artistSelections). No imports, so it can be
// loaded by plain Node tests.

const ARTIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same as the server's proposal key pattern.
const PROPOSAL_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Request fields for a suggestion's credit rows. `links` is one entry per
// credit, in credit order (null when the credit has no picker selection).
//
// Sharing is explicit, never by name:
// - A link restored from a stored revision keeps its `proposalKey`, so
//   credits that shared one proposal (for example one new community artist
//   credited twice) still share it after a revision.
// - The same MusicBrainz MBID always shares one proposal: that is an exact
//   identity, and the server refuses two proposals for one MBID.
// - A community artist chosen in the picker gets its own proposal, even if
//   another has the same name.
// Returns {} when nothing is linked, so legacy payloads are unchanged.
export function artistRequestFields(links) {
  const list = Array.isArray(links) ? links : [];
  const artistProposals = [];
  const artistSelections = [];
  const proposalsByKey = new Map();
  const musicBrainzKeys = new Map();
  const reserved = new Set(list.map((link) => link?.proposalKey).filter((key) => PROPOSAL_KEY.test(String(key || ""))));
  const counters = { mb: 0, new: 0 };
  const freshKey = (prefix) => {
    let key;
    do {
      counters[prefix] += 1;
      key = `${prefix}-${counters[prefix]}`;
    } while (reserved.has(key) || proposalsByKey.has(key));
    return key;
  };
  // A restored key is reused only for the same kind of proposal.
  const restoredKey = (link, kind) => {
    const key = PROPOSAL_KEY.test(String(link.proposalKey || "")) ? link.proposalKey : "";
    if (!key) return "";
    const existing = proposalsByKey.get(key);
    return !existing || existing.kind === kind ? key : "";
  };

  list.forEach((link, position) => {
    if (!link) return;
    if (link.kind === "existing" && ARTIST_ID.test(String(link.artistId || ""))) {
      artistSelections.push({ position, kind: "existing", artistId: link.artistId.toLowerCase() });
    } else if (link.kind === "musicbrainz" && MBID.test(String(link.artistMbid || ""))) {
      const artistMbid = link.artistMbid.toLowerCase();
      let proposalKey = musicBrainzKeys.get(artistMbid);
      if (!proposalKey) {
        const restored = restoredKey(link, "musicbrainz");
        proposalKey = restored && !proposalsByKey.has(restored) ? restored : freshKey("mb");
        const proposal = { proposalKey, kind: "musicbrainz", artistMbid };
        musicBrainzKeys.set(artistMbid, proposalKey);
        proposalsByKey.set(proposalKey, proposal);
        artistProposals.push(proposal);
      }
      artistSelections.push({ position, kind: "proposal", proposalKey });
    } else if (link.kind === "community" && link.canonicalName) {
      const restored = restoredKey(link, "community");
      let proposalKey = restored;
      if (!restored || !proposalsByKey.has(restored)) {
        proposalKey = restored || freshKey("new");
        const proposal = {
          proposalKey,
          kind: "community",
          canonicalName: link.canonicalName,
          evidence: (Array.isArray(link.evidence) ? link.evidence : []).map((entry) => ({ url: entry.url })),
        };
        proposalsByKey.set(proposalKey, proposal);
        artistProposals.push(proposal);
      }
      artistSelections.push({ position, kind: "proposal", proposalKey });
    }
  });
  return artistSelections.length ? { artistProposals, artistSelections } : {};
}

// Picker selections recovered from a stored suggestion, one per credit
// position, for revising it. Proposal links keep their stored proposalKey so
// explicit sharing survives the revision. Existing artists show the credit wording, since
// the contributor's view has no registry names.
export function linksFromSubmission(source) {
  const credits = Array.isArray(source?.proposedMetadata?.artistCredits) ? source.proposedMetadata.artistCredits : [];
  const proposals = new Map((Array.isArray(source?.artistProposals) ? source.artistProposals : []).map((proposal) => [proposal.proposalKey, proposal]));
  const links = credits.map(() => null);
  for (const selection of Array.isArray(source?.artistSelections) ? source.artistSelections : []) {
    if (!Number.isInteger(selection?.position) || selection.position < 0 || selection.position >= links.length) continue;
    if (selection.kind === "existing") {
      links[selection.position] = { kind: "existing", artistId: selection.artistId, name: credits[selection.position]?.name || "Rescened artist", artistMbid: "" };
      continue;
    }
    const proposal = proposals.get(selection.proposalKey);
    if (proposal?.kind === "musicbrainz") {
      const observation = proposal.observation || {};
      links[selection.position] = {
        kind: "musicbrainz",
        proposalKey: proposal.proposalKey,
        artistMbid: proposal.artistMbid,
        name: observation.name || proposal.artistMbid,
        disambiguation: observation.disambiguation || "",
        type: observation.type || "",
        country: "",
      };
    } else if (proposal?.kind === "community") {
      links[selection.position] = {
        kind: "community",
        proposalKey: proposal.proposalKey,
        canonicalName: proposal.canonicalName,
        evidence: (proposal.evidence || []).map((entry) => ({ url: entry.url })),
      };
    }
  }
  return links;
}
