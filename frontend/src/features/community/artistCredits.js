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

export function musicBrainzArtistUrl(identity) {
  return identity?.artistMbid && MBID.test(identity.artistMbid)
    ? `https://musicbrainz.org/artist/${identity.artistMbid.toLowerCase()}`
    : "";
}

// Turns the correction form's comma-separated names back into credits. Each
// name reuses the role and identity of the first unused known credit with the
// exact same name; any other name becomes a new "main" credit.
export function creditsFromNames(text, knownCredits = []) {
  const pool = (Array.isArray(knownCredits) ? knownCredits : []).filter((credit) => credit?.name);
  const used = new Set();
  return String(text || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const index = pool.findIndex((credit, position) => !used.has(position) && String(credit.name).trim() === name);
      if (index === -1) return { name, role: "main" };
      used.add(index);
      const match = pool[index];
      return creditPayload(name, String(match.role || "").trim() || "main", creditIdentity(match));
    });
}
