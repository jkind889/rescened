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

// MusicBrainz discography filters. Album, EP, and single mean that
// MusicBrainz primary type with no secondary type; they are not a guarantee
// of official studio releases.
// `noun` names what the filter shows; `scope` names what MusicBrainz's raw
// browse count covers for that request, before local verification.
// `nounOne`/`scopeOne` are the singular forms.
export const DISCOGRAPHY_FILTERS = [
  { value: "album", label: "Albums", noun: "album groups without a secondary type", nounOne: "album group without a secondary type", scope: "album-type groups (including live, compilation, and other secondary types)", scopeOne: "album-type group (including live, compilation, and other secondary types)" },
  { value: "ep", label: "EPs", noun: "EP groups without a secondary type", nounOne: "EP group without a secondary type", scope: "EP-type groups (including secondary types)", scopeOne: "EP-type group (including secondary types)" },
  { value: "single", label: "Singles", noun: "single groups without a secondary type", nounOne: "single group without a secondary type", scope: "single-type groups (including secondary types)", scopeOne: "single-type group (including secondary types)" },
  { value: "other", label: "Other", noun: "other release groups", nounOne: "other release group", scope: "release groups of every type", scopeOne: "release group of any type" },
  { value: "all", label: "All", noun: "release groups", nounOne: "release group", scope: "release groups of every type", scopeOne: "release group of any type" },
];

// Mount the MusicBrainz section only when the artist header says this API
// serves it. Older APIs omit `features`, so their pages stay unchanged.
export function discographyAdvertised(detail) {
  return detail?.features?.discography === true;
}

// Errors that mean "this API has no discography for us": the coded
// disabled responses, or a 404/503 without our code (an older API with no
// route). The coded ARTIST_DISCOGRAPHY_NOT_AVAILABLE 404 is a real answer
// and is shown in the section instead.
export function discographyHidden(error) {
  if (!error) return false;
  if (["ARTIST_DISCOGRAPHY_DISABLED", "ARTIST_PAGES_DISABLED"].includes(error.code)) return true;
  return !error.code && [404, 503].includes(error.status);
}

// Appends a provider page, dropping release groups already shown, because
// MusicBrainz pages can overlap between requests. Returns how many rows were new.
export function mergeDiscographyRows(existing, incoming) {
  const seen = new Set((existing || []).map((row) => row.externalId));
  const added = [];
  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (!row?.externalId || seen.has(row.externalId)) continue;
    seen.add(row.externalId);
    added.push(row);
  }
  return { rows: [...(existing || []), ...added], added: added.length };
}

// Coverage and order wording that matches what was actually loaded. The
// provider count is MusicBrainz's raw browse total for the request's scope,
// which is not the number of rows matching the filter; `shown` is the
// verified rows loaded so far.
export function discographySummary({ filter, providerCount, shown, pagesLoaded, pageSize = 100, hasMore }) {
  const option = DISCOGRAPHY_FILTERS.find((item) => item.value === filter) || DISCOGRAPHY_FILTERS[0];
  const scope = Number.isInteger(providerCount)
    ? `MusicBrainz's default view has ${providerCount} ${providerCount === 1 ? option.scopeOne : option.scope} for this artist`
    : "MusicBrainz did not report a total";
  const order = pagesLoaded > 1 || hasMore || (Number.isInteger(providerCount) && providerCount > pageSize)
    ? `newest first within each batch of up to ${pageSize}`
    : "newest first";
  const more = hasMore ? " so far" : "";
  return `${scope}. Showing ${shown} verified ${shown === 1 ? option.nounOne : option.noun}${more}, ${order}.`;
}

// Load the cached biography only when the API says it serves biographies.
export function biographyAdvertised(detail) {
  return detail?.features?.biography === true;
}

// The change notice required when reusing Wikipedia text: always an
// excerpt of the lead; "shortened" when it is not the whole lead; "edited"
// when a moderator corrected the wording.
export function biographyChangeNotice(biography) {
  if (!biography) return "";
  const parts = ["Excerpt"];
  if (biography.shortened) parts.push("shortened");
  if (biography.edited) parts.push("edited by Rescened moderators");
  return parts.join(", ");
}

const BIOGRAPHY_STATE_LABELS = {
  verified: "Verified match",
  needs_review: "Needs review",
  conflict: "Conflicting evidence",
  not_linked: "No Wikidata link",
  no_article: "No English article",
  unsuitable: "Article not usable",
  unchecked: "Not checked yet",
};

export function biographyStateLabel(state) {
  return BIOGRAPHY_STATE_LABELS[state] || "Unknown";
}

// Drops stale async results. begin() returns a token for one request;
// isCurrent(token) is false once a newer request began or invalidate() ran
// (for example on sign-out, user switch, or unmount).
export function createRequestGuard() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; },
    isCurrent(token) { return token === generation; },
  };
}

// Text the correction box should show for a record: the current correction,
// otherwise the published excerpt.
export function correctionDraftFor(record) {
  return record?.manual?.text || record?.accepted?.text || "";
}
