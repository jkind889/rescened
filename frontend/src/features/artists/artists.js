// Pure helpers for artist pages and artist credit links. A credit links to an
// artist page only when it carries an artistId that the API confirmed resolves
// to a registry artist. Display names are never split or matched to infer one.

export const RELEASE_FILTERS = [
  { value: "all", label: "All" },
  { value: "album", label: "Albums" },
  { value: "ep", label: "EPs" },
  { value: "single", label: "Singles" },
  { value: "mixtape", label: "Mixtapes" },
  { value: "other", label: "Other" },
];

const RELEASE_TYPE_LABELS = {
  album: "Album",
  ep: "EP",
  single: "Single",
  mixtape: "Mixtape",
  soundtrack: "Soundtrack",
  compilation: "Compilation",
  live: "Live",
  remix: "Remix",
  other: "Release",
};

const ROLE_LABELS = { featured: "Featured", featuring: "Featured", guest: "Guest" };

export function releaseTypeLabel(type) {
  return RELEASE_TYPE_LABELS[type] || RELEASE_TYPE_LABELS.other;
}

export function releaseFilterFrom(value) {
  return RELEASE_FILTERS.some((filter) => filter.value === value) ? value : "all";
}

// Filters worth offering: "All" plus every group with at least one release.
// The selected filter stays visible even when its count is zero.
export function visibleReleaseFilters(counts, selected = "all") {
  return RELEASE_FILTERS.filter((filter) => (
    filter.value === "all" || filter.value === selected || Number(counts?.[filter.value]) > 0
  ));
}

// Credit segments for display, in stored order. `linkedArtistIds` comes from
// the album response's artistPages.artistIds; without it nothing is linked.
export function creditSegments(album, linkedArtistIds) {
  const linked = new Set(Array.isArray(linkedArtistIds) ? linkedArtistIds : []);
  const credits = Array.isArray(album?.artistCredits) ? album.artistCredits.filter((credit) => credit?.name) : [];
  if (!credits.length) return album?.artistDisplayName ? [{ name: album.artistDisplayName, artistId: null }] : [];
  return credits.map((credit) => ({
    name: credit.name,
    artistId: typeof credit.artistId === "string" && linked.has(credit.artistId) ? credit.artistId : null,
  }));
}

// Other credits on a release shown on one artist's page. Credits that belong
// to the page's artist are left out by identity, never by name.
export function otherCredits(release, artistId) {
  return (Array.isArray(release?.artistCredits) ? release.artistCredits : [])
    .filter((credit) => credit?.name && credit.artistId !== artistId);
}

// A short note for how the page's artist appears on a release.
export function releaseCreditNote(release) {
  const roles = (Array.isArray(release?.creditRoles) ? release.creditRoles : []).filter((role) => role && role !== "main");
  const labels = [...new Set(roles.map((role) => ROLE_LABELS[String(role).toLowerCase()] || String(role)))];
  if (labels.length) return labels.join(", ");
  return release?.collaboration ? "Collaboration" : "";
}

export function releaseCountLabel(count) {
  const value = Number(count) || 0;
  return `${value} release${value === 1 ? "" : "s"} on Rescened`;
}

// One line that tells same-named artists apart in search: how the query
// matched, how many linked releases there are, and up to two of them.
export function artistMatchSummary(result) {
  const parts = [];
  if (result?.match?.name) parts.push(`${result.match.kind === "alias" ? "Also known as" : "Credited as"} ${result.match.name}`);
  const count = Number(result?.releaseCount) || 0;
  parts.push(`${count} release${count === 1 ? "" : "s"}`);
  if (Array.isArray(result?.knownFor) && result.knownFor.length) parts.push(result.knownFor.join(", "));
  return parts.join(" · ");
}
