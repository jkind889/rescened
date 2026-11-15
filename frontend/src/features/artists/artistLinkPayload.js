// Pure mapping between artist-picker selections and the suggestion request
// fields (artistProposals and artistSelections). No imports, so it can be
// loaded by plain Node tests.

const ARTIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Request fields for a suggestion's credit rows. `links` is one entry per
// credit, in credit order (null when the credit has no picker selection).
// The same MusicBrainz artist chosen for several credits shares one proposal
// (the server refuses two proposals for one MBID); each new community artist
// is its own proposal. Returns {} when nothing is linked, so legacy payloads
// are unchanged.
export function artistRequestFields(links) {
  const artistProposals = [];
  const artistSelections = [];
  const musicBrainzKeys = new Map();
  let communityCount = 0;
  (Array.isArray(links) ? links : []).forEach((link, position) => {
    if (!link) return;
    if (link.kind === "existing" && ARTIST_ID.test(String(link.artistId || ""))) {
      artistSelections.push({ position, kind: "existing", artistId: link.artistId.toLowerCase() });
    } else if (link.kind === "musicbrainz" && MBID.test(String(link.artistMbid || ""))) {
      const artistMbid = link.artistMbid.toLowerCase();
      let proposalKey = musicBrainzKeys.get(artistMbid);
      if (!proposalKey) {
        proposalKey = `mb-${musicBrainzKeys.size + 1}`;
        musicBrainzKeys.set(artistMbid, proposalKey);
        artistProposals.push({ proposalKey, kind: "musicbrainz", artistMbid });
      }
      artistSelections.push({ position, kind: "proposal", proposalKey });
    } else if (link.kind === "community" && link.canonicalName) {
      communityCount += 1;
      const proposalKey = `new-${communityCount}`;
      artistProposals.push({
        proposalKey,
        kind: "community",
        canonicalName: link.canonicalName,
        evidence: (Array.isArray(link.evidence) ? link.evidence : []).map((entry) => ({ url: entry.url })),
      });
      artistSelections.push({ position, kind: "proposal", proposalKey });
    }
  });
  return artistSelections.length ? { artistProposals, artistSelections } : {};
}

// Picker selections recovered from a stored suggestion, one per credit
// position, for revising it. Existing artists show the credit wording, since
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
        artistMbid: proposal.artistMbid,
        name: observation.name || proposal.artistMbid,
        disambiguation: observation.disambiguation || "",
        type: observation.type || "",
        country: "",
      };
    } else if (proposal?.kind === "community") {
      links[selection.position] = {
        kind: "community",
        canonicalName: proposal.canonicalName,
        evidence: (proposal.evidence || []).map((entry) => ({ url: entry.url })),
      };
    }
  }
  return links;
}
