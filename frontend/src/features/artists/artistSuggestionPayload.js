// Pure helpers for standalone artist suggestions. No imports, so plain Node
// tests can load this file.

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The request proposal for a picker selection. An existing Rescened artist
// is not a suggestion (null): the page points to that artist instead.
export function proposalFromSelection(selection) {
  if (!selection) return null;
  if (selection.kind === "musicbrainz" && MBID.test(String(selection.artistMbid || ""))) {
    return { kind: "musicbrainz", artistMbid: selection.artistMbid.toLowerCase() };
  }
  if (selection.kind === "community" && selection.canonicalName) {
    return {
      kind: "community",
      canonicalName: selection.canonicalName,
      evidence: (Array.isArray(selection.evidence) ? selection.evidence : []).map((entry) => ({ url: entry.url })),
    };
  }
  return null;
}

// The picker selection for a stored proposal, for revising it.
export function selectionFromProposal(proposal) {
  if (proposal?.kind === "musicbrainz") {
    const observation = proposal.observation || {};
    return {
      kind: "musicbrainz",
      artistMbid: proposal.artistMbid,
      name: observation.name || proposal.artistMbid,
      disambiguation: observation.disambiguation || "",
      type: observation.type || "",
      country: "",
    };
  }
  if (proposal?.kind === "community") {
    return { kind: "community", canonicalName: proposal.canonicalName, evidence: (proposal.evidence || []).map((entry) => ({ url: entry.url })) };
  }
  return null;
}

export function proposalName(proposal) {
  if (proposal?.kind === "musicbrainz") return proposal.observation?.name || proposal.artistMbid || "";
  return proposal?.canonicalName || "";
}

const STATUS_LABELS = {
  pending: "Waiting for review",
  needs_changes: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  duplicate: "Already on Rescened",
  withdrawn: "Withdrawn",
};

export function artistSuggestionStatusLabel(status) {
  return STATUS_LABELS[status] || "Unknown";
}

const ACTION_LABELS = {
  submitted: "Submitted",
  revised: "Revised",
  withdrawn: "Withdrawn",
  request_changes: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  marked_duplicate: "Marked as already on Rescened",
};

export function artistSuggestionActionLabel(action) {
  return ACTION_LABELS[action] || action;
}
