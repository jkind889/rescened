// Resolves a registry artist's English Wikipedia biography from its stored
// MusicBrainz identity, conservatively. A biography is accepted only when:
//   1. MusicBrainz returns the exact requested or verified canonical artist with exactly
//      one current, explicitly typed "wikidata" URL relationship;
//   2. that Wikidata item (after bounded redirect validation) has a non-deprecated P434
//      (MusicBrainz artist ID) claim equal to the canonical MBID, with only plain or
//      descriptive name qualifiers; multiple IDs require corroborated aliases;
//   3. the MusicBrainz artist type and the item's P31 classes agree on
//      person versus group (or pass the narrow reciprocal solo-project bridge);
//   4. the item's English sitelink is an existing namespace-0 article whose
//      own wikibase_item is the same item, not a disambiguation page or list,
//      and not a redirect to another entity;
//   5. the exact revision's lead yields usable prose.
// Names are never compared. Anything else ends as a conflict (evidence
// contradicts the match), needs_review (evidence incomplete or unfamiliar),
// unsuitable (no usable article), or an operational error.

const { BiographySourceError } = require("./biographySources");
const { BiographyTextError, leadParagraphsFromParseHtml, shortenBiography, textHash } = require("./biographyText");
const { normalizeArtistMbid } = require("./identity");

const LICENSE = Object.freeze({ name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" });
// P31 classes treated as compatible. Unlisted classes go to review rather
// than being accepted or rejected by guesswork; no subclass traversal.
const PERSON_CLASSES = new Set(["Q5"]); // human
const GROUP_CLASSES = new Set([
  "Q215380", // musical group
  "Q2088357", // musical ensemble
  "Q5741069", // rock band
  "Q9212979", // musical duo
  "Q641066", // girl group
  "Q216337", // boy band
  "Q281643", // musical trio (subclass of musical ensemble)
  "Q56816954", // heavy metal band (subclass of rock band)
]);
const { canonicalArtist, linkedEntity, p434Problem, verifyPersonAliases, verifySoloProject } = require("./biographyIdentity");
const MUSICBRAINZ_KINDS = { Person: "person", Group: "group", Orchestra: "group", Choir: "group" };
// Classes that contradict "real musician or group" outright. Any of these
// vetoes the match even when a person or group class is also present.
const INCOMPATIBLE_CLASSES = new Set([
  "Q95074", // fictional character
  "Q15632617", // fictional human
  "Q4167410", // Wikimedia disambiguation page
  "Q13406463", // Wikimedia list article
  "Q18127", // record label
  "Q482994", // album
  "Q101352", // family name
  "Q202444", // given name
  "Q7725634", // literary work
]);

function articleUrls(title, revisionId) {
  const path = encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/").replace(/%3A/g, ":");
  return { url: `https://en.wikipedia.org/wiki/${path}`, revisionUrl: `https://en.wikipedia.org/w/index.php?oldid=${revisionId}` };
}

function outcome(status, { reasons = [], qid = null, evidence = {}, candidate = null, error = null } = {}) {
  return { status, reasons: [...new Set(reasons)], qid, evidence, candidate, error };
}

function entityKind(p31) {
  if (p31.some((id) => INCOMPATIBLE_CLASSES.has(id))) return "incompatible";
  const person = p31.some((id) => PERSON_CLASSES.has(id));
  const group = p31.some((id) => GROUP_CLASSES.has(id));
  if (person && group) return "ambiguous";
  if (person) return "person";
  if (group) return "group";
  return "unrecognized";
}

// Fetches and validates the lead of one exact revision for an already
// validated page, returning an excerpt or a non-accepted outcome.
async function excerptFromPage({ sources, page, qid, maxGraphemes, now }) {
  const lead = await sources.wikipediaLead(page.lastRevisionId);
  if (lead.revisionId !== page.lastRevisionId || lead.pageId !== page.pageId) {
    throw new BiographySourceError("Wikipedia returned a different revision than requested", { code: "BIOGRAPHY_INVALID_RESPONSE", provider: "wikipedia" });
  }
  if (lead.wikibaseItem !== qid) return { problem: { status: "conflict", reasons: ["REVISION_WIKIBASE_ITEM_MISMATCH"] } };
  if (lead.disambiguation) return { problem: { status: "unsuitable", reasons: ["DISAMBIGUATION_PAGE"] } };
  let excerpt;
  try {
    excerpt = shortenBiography(leadParagraphsFromParseHtml(lead.html), { maxGraphemes });
  } catch (error) {
    if (error instanceof BiographyTextError) return { problem: { status: "unsuitable", reasons: [error.code === "BIOGRAPHY_INVALID_RESPONSE" ? "INVALID_LEAD_HTML" : "NO_USABLE_LEAD"] } };
    throw error;
  }
  const title = lead.title || page.title;
  return {
    excerpt: {
      text: excerpt.text,
      textHash: textHash(excerpt.text),
      extractionVersion: excerpt.extractionVersion,
      shortened: excerpt.shortened,
      cut: excerpt.cut,
      qid,
      article: {
        language: "en", title, pageId: page.pageId, revisionId: lead.revisionId,
        ...(page.lastRevisionTimestamp ? { revisionTimestamp: page.lastRevisionTimestamp } : {}),
        ...articleUrls(title, lead.revisionId),
      },
      license: { ...LICENSE },
      retrievedAt: now,
    },
  };
}

function pageProblems(page, qid) {
  if (page.missing) return { status: "unsuitable", reasons: ["ARTICLE_MISSING"] };
  if (page.ns !== 0) return { status: "unsuitable", reasons: ["NOT_AN_ARTICLE"] };
  if (page.wikibaseItem !== qid) return { status: "conflict", reasons: [page.redirected ? "CROSS_ENTITY_REDIRECT" : "WIKIBASE_ITEM_MISMATCH"] };
  if (page.disambiguation) return { status: "unsuitable", reasons: ["DISAMBIGUATION_PAGE"] };
  if (/^lists? of /i.test(page.title)) return { status: "unsuitable", reasons: ["LIST_PAGE"] };
  return null;
}

async function resolveBiography({ artistMbid, sources, maxGraphemes = 250, now = new Date() }) {
  const mbid = normalizeArtistMbid(artistMbid);
  if (!mbid) return outcome("not_linked", { reasons: ["NO_MUSICBRAINZ_ID"] });
  const evidence = { artistMbid: mbid };
  try {
    const artist = await canonicalArtist(mbid, sources, evidence);
    if (!artist) return outcome("needs_review", { reasons: ["MUSICBRAINZ_REDIRECT_UNVERIFIED"], evidence });
    evidence.musicBrainzType = artist.type;

    const linked = await linkedEntity(artist, sources, evidence);
    const { qid, entity } = linked;
    if (linked.problem) {
      const status = linked.problem === "NO_WIKIDATA_LINK" ? "not_linked" : linked.problem === "MULTIPLE_WIKIDATA_LINKS" ? "conflict" : "needs_review";
      return outcome(status, { reasons: [linked.problem], qid, evidence });
    }
    evidence.p434 = entity.p434;
    evidence.p31 = entity.p31;
    const claimProblem = p434Problem(entity.p434, artist.id);
    if (claimProblem) return outcome(claimProblem.status, { reasons: [claimProblem.reason], qid, evidence });
    if (!(await verifyPersonAliases({ artist, entity, sources, now, kindOf: entityKind, evidence }))) {
      return outcome("needs_review", { reasons: ["MULTIPLE_P434_IDENTITIES_UNVERIFIED"], qid, evidence });
    }

    const reviewReasons = [];
    const itemKind = entityKind(entity.p31);
    const artistKind = MUSICBRAINZ_KINDS[artist.type] || null;
    if (itemKind === "incompatible") return outcome("conflict", { reasons: ["ENTITY_TYPE_INCOMPATIBLE"], qid, evidence });
    if (itemKind === "ambiguous") return outcome("conflict", { reasons: ["ENTITY_TYPE_AMBIGUOUS"], qid, evidence });
    if (itemKind !== "unrecognized" && artistKind && itemKind !== artistKind) {
      if (!(await verifySoloProject({ artist, entity, sources, now, kindOf: entityKind, evidence }))) {
        return outcome("conflict", { reasons: ["ENTITY_TYPE_MISMATCH"], qid, evidence });
      }
    }
    if (itemKind === "unrecognized") reviewReasons.push("ENTITY_TYPE_UNRECOGNIZED");
    if (!artistKind) reviewReasons.push("MUSICBRAINZ_TYPE_UNRECOGNIZED");

    evidence.sitelinkTitle = entity.sitelinkTitle;
    if (!entity.sitelinkTitle) return outcome("no_article", { reasons: ["NO_ENGLISH_ARTICLE", ...reviewReasons], qid, evidence });
    const page = await sources.wikipediaPage(entity.sitelinkTitle);
    const problem = pageProblems(page, qid);
    if (problem) return outcome(problem.status, { reasons: problem.reasons, qid, evidence: { ...evidence, pageId: page.pageId ?? null } });
    evidence.pageId = page.pageId;
    const result = await excerptFromPage({ sources, page, qid, maxGraphemes, now });
    if (result.problem) return outcome(result.problem.status, { reasons: result.problem.reasons, qid, evidence });
    return outcome(reviewReasons.length ? "needs_review" : "accepted", { reasons: reviewReasons, qid, evidence, candidate: result.excerpt });
  } catch (error) {
    if (error instanceof BiographySourceError) {
      if (error.provider === "musicbrainz" && error.code === "BIOGRAPHY_MUSICBRAINZ_MERGED") return outcome("conflict", { reasons: ["MUSICBRAINZ_ARTIST_REDIRECTED"], evidence: { ...evidence, musicBrainzId: error.redirectedArtistMbid } });
      return outcome("error", { evidence, error: { code: error.code, provider: error.provider || null, transient: error.transient === true } });
    }
    throw error;
  }
}

// Content refresh for an accepted article: one page check by stable page ID,
// and a pinned-revision fetch only when the revision changed. Identity is
// not re-resolved here.
async function refreshArticle({ accepted, sources, maxGraphemes = 250, now = new Date() }) {
  try {
    const page = await sources.wikipediaPageById(accepted.article.pageId);
    const problem = pageProblems(page, accepted.qid);
    if (problem) return outcome(problem.status, { reasons: problem.reasons, qid: accepted.qid });
    // The stored page ID now resolves to another page (for example through a
    // redirect). Same item or not, a different page is a changed match: hold
    // it for review rather than replacing the published article.
    const pageChanged = page.pageId !== accepted.article.pageId;
    if (!pageChanged && page.lastRevisionId === accepted.article.revisionId) return outcome("unchanged", { qid: accepted.qid });
    const result = await excerptFromPage({ sources, page, qid: accepted.qid, maxGraphemes, now });
    if (result.problem) return outcome(result.problem.status, { reasons: result.problem.reasons, qid: accepted.qid });
    if (pageChanged) return outcome("needs_review", { reasons: ["MATCH_CHANGED", "PAGE_CHANGED"], qid: accepted.qid, candidate: result.excerpt, evidence: { previousPageId: accepted.article.pageId, pageId: page.pageId } });
    return outcome("accepted", { qid: accepted.qid, candidate: result.excerpt });
  } catch (error) {
    if (error instanceof BiographySourceError) return outcome("error", { qid: accepted.qid, error: { code: error.code, provider: error.provider || null, transient: error.transient === true } });
    throw error;
  }
}

module.exports = { GROUP_CLASSES, INCOMPATIBLE_CLASSES, LICENSE, PERSON_CLASSES, articleUrls, refreshArticle, resolveBiography };
