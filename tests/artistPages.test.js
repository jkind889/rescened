const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const { REVIEWED_ARTIST_ALIASES, reviewedAliasesFor, validateReviewedAliases } = require("../lib/artists/reviewedAliases");
const { foldSearchKey, parseReleaseQuery, parseSearch, artistDetail, artistReleases, releaseCard, hasOtherCreditedParty } = require("../lib/artists/read");
const { buildRankedCatalogSearchPipeline } = require("../routes/utils/catalogSearch");
const { isArtistPagesEnabled } = require("../routes/utils/serverConfig");

const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists/artists.js"), "utf8");
const helpers = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const KANYE = "164f0d73-1234-4e2c-8743-d77bf2191051";
const BTS = "0d79fe8e-ba27-4859-bb8c-2f255f346853";
const ARTIST_A = "11111111-1111-4111-8111-111111111111";
const ARTIST_B = "22222222-2222-4222-8222-222222222222";

test("reviewed aliases are keyed by MBID and keep native-script spellings", () => {
  assert.deepEqual(reviewedAliasesFor(BTS).map((alias) => alias.name), ["방탄소년단", "Bangtan Sonyeondan", "Bangtan Boys"]);
  assert.equal(reviewedAliasesFor(BTS)[0].locale, "ko");
  assert.deepEqual(reviewedAliasesFor(KANYE.toUpperCase()).map((alias) => alias.name), ["Ye"]);
  assert.deepEqual(reviewedAliasesFor("not-an-mbid"), []);
  assert.deepEqual(reviewedAliasesFor("00000000-0000-0000-0000-000000000000"), []);
  assert.equal(new Set(REVIEWED_ARTIST_ALIASES.map((entry) => entry.artistMbid)).size, REVIEWED_ARTIST_ALIASES.length);
  assert.ok(Object.isFrozen(REVIEWED_ARTIST_ALIASES[0].aliases));
});

test("reviewed alias validation rejects ambiguous or malformed entries", () => {
  const valid = { artistMbid: BTS, aliases: [{ name: "방탄소년단", locale: "ko" }] };
  assert.equal(validateReviewedAliases([valid]).length, 1);
  assert.throws(() => validateReviewedAliases([valid, valid]), /repeats MBID/);
  assert.throws(() => validateReviewedAliases([{ ...valid, artistMbid: BTS.toUpperCase() }]), /lowercase/);
  assert.throws(() => validateReviewedAliases([{ ...valid, artistMbid: "bts" }]), /MBID/);
  assert.throws(() => validateReviewedAliases([{ ...valid, aliases: [] }]), /no aliases/);
  assert.throws(() => validateReviewedAliases([{ ...valid, aliases: [{ name: " padded " }] }]), /invalid alias name/);
  // Decomposed Hangul is not NFC.
  assert.throws(() => validateReviewedAliases([{ ...valid, aliases: [{ name: "방탄".normalize("NFD") }] }]), /invalid alias name/);
  assert.throws(() => validateReviewedAliases([{ ...valid, aliases: [{ name: "BTS", locale: "Korean" }] }]), /invalid locale/);
  assert.throws(() => validateReviewedAliases([{ ...valid, aliases: [{ name: "BTS" }, { name: "BTS" }] }]), /repeated/);
});

test("search keys fold Latin case and accents but never other scripts", () => {
  assert.equal(foldSearchKey("  Björk  "), "bjork");
  assert.equal(foldSearchKey("Björk"), "bjork");
  assert.equal(foldSearchKey("Pi’erre   Bourne"), "pi'erre bourne");
  assert.equal(foldSearchKey("방탄소년단"), "방탄소년단");
  assert.notEqual(foldSearchKey("が"), foldSearchKey("か"), "kana voicing marks are significant");
  assert.equal(foldSearchKey("宇多田ヒカル"), "宇多田ヒカル");
  assert.equal(foldSearchKey("ΣΙΓΜΑ"), "σιγμα");
});

test("release and search queries reject unknown fields and bad bounds", () => {
  assert.deepEqual(parseReleaseQuery({}), { type: "all", limit: 24, cursor: null });
  assert.deepEqual(parseReleaseQuery({ type: "ep", limit: "48" }), { type: "ep", limit: 48, cursor: null });
  for (const query of [{ type: "soundtrack" }, { limit: "0" }, { limit: "49" }, { limit: "2.5" }, { sort: "rating" }, { type: ["ep"] }]) {
    assert.throws(() => parseReleaseQuery(query), (error) => error.status === 400 && error.code === "INVALID_ARTIST_RELEASES", JSON.stringify(query));
  }
  assert.throws(() => parseReleaseQuery({ cursor: "" }), { code: "INVALID_ARTIST_CURSOR" });
  assert.throws(() => parseReleaseQuery({ cursor: "x".repeat(2049) }), { code: "INVALID_ARTIST_CURSOR" });

  assert.deepEqual(parseSearch({ q: "  이달의   소녀 " }), { q: "이달의 소녀", limit: 6 });
  assert.throws(() => parseSearch({ q: "x".repeat(201) }), { code: "INVALID_ARTIST_SEARCH" });
  assert.throws(() => parseSearch({ q: "air", limit: "13" }), { code: "INVALID_ARTIST_SEARCH" });
  assert.throws(() => parseSearch({ q: "air", page: "2" }), { code: "INVALID_ARTIST_SEARCH" });
});

test("artist reads reject malformed public IDs before touching the database", async () => {
  for (const id of ["", "not-an-id", "507f1f77bcf86cd799439011", "11111111-1111-1111-8111-111111111111"]) {
    await assert.rejects(artistDetail(id), (error) => error.status === 400 && error.code === "INVALID_ARTIST_ID");
    await assert.rejects(artistReleases(id, {}), (error) => error.status === 400 && error.code === "INVALID_ARTIST_ID");
  }
});

test("identity search expansion is additive and absent without artist IDs", () => {
  const baseline = buildRankedCatalogSearchPipeline("Radiohead");
  assert.deepEqual(buildRankedCatalogSearchPipeline("Radiohead", { artistIds: [] }), baseline);
  const expanded = buildRankedCatalogSearchPipeline("Radiohead", { artistIds: [ARTIST_A] });
  assert.deepEqual(expanded[0].$match.$or[0], baseline[0].$match, "ordinary text matching is kept");
  assert.deepEqual(expanded[0].$match.$or[1], { "artistCredits.artistId": { $in: [ARTIST_A] } });
  const branches = expanded[1].$set.searchRank.$switch.branches;
  assert.equal(branches.length, baseline[1].$set.searchRank.$switch.branches.length + 1);
  assert.equal(branches[0].then, 0, "identity matches rank with exact artist matches");
  // Curated name preferences keep their place ahead of identity matches.
  const loona = buildRankedCatalogSearchPipeline("LOONA", { artistIds: [ARTIST_A] });
  assert.equal(loona[0].$match.$or.length, 3);
  assert.deepEqual(loona[1].$set.searchRank.$switch.branches.slice(0, 2).map((branch) => branch.then), [-1, 0]);
});

test("artist page flag is off unless explicitly enabled", () => {
  assert.equal(isArtistPagesEnabled({}), false);
  assert.equal(isArtistPagesEnabled({ ARTIST_PAGES_ENABLED: "false" }), false);
  assert.equal(isArtistPagesEnabled({ ARTIST_PAGES_ENABLED: " TRUE " }), true);
});

test("artist routes return 503 while disabled and validate IDs when enabled", async () => {
  const previous = process.env.ARTIST_PAGES_ENABLED;
  const app = express();
  app.use("/artists", require("../routes/artists"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/artists`;
  try {
    delete process.env.ARTIST_PAGES_ENABLED;
    for (const route of ["/search?q=air", `/${ARTIST_A}`, `/${ARTIST_A}/releases`]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "ARTIST_PAGES_DISABLED");
    }
    process.env.ARTIST_PAGES_ENABLED = "true";
    const invalid = await fetch(`${base}/not-an-id`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "INVALID_ARTIST_ID");
    const badQuery = await fetch(`${base}/search?q=air&limit=99`);
    assert.equal(badQuery.status, 400);
    assert.equal((await badQuery.json()).code, "INVALID_ARTIST_SEARCH");
    const empty = await fetch(`${base}/search?q=%20`);
    assert.deepEqual(await empty.json(), { results: [] });
  } finally {
    if (previous === undefined) delete process.env.ARTIST_PAGES_ENABLED;
    else process.env.ARTIST_PAGES_ENABLED = previous;
    server.close();
  }
});

test("credit links use only confirmed artist IDs and never split display names", async () => {
  const { creditSegments } = await helpers;
  const album = {
    artistDisplayName: "JAY-Z & Kanye West",
    artistCredits: [
      { name: "JAY-Z", role: "main", artistId: ARTIST_A },
      { name: "Kanye West", role: "main", artistId: ARTIST_B },
      { name: "Unlinked Guest", role: "featured" },
    ],
  };
  assert.deepEqual(creditSegments(album, [ARTIST_A]), [
    { name: "JAY-Z", artistId: ARTIST_A },
    { name: "Kanye West", artistId: null },
    { name: "Unlinked Guest", artistId: null },
  ]);
  assert.deepEqual(creditSegments(album, undefined).map((segment) => segment.artistId), [null, null, null]);
  assert.deepEqual(creditSegments({ artistDisplayName: "JAY-Z & Kanye West", artistCredits: [] }, [ARTIST_A]), [
    { name: "JAY-Z & Kanye West", artistId: null },
  ]);
  assert.deepEqual(creditSegments({}, []), []);
});

test("release cards describe collaborators by identity, not by name", async () => {
  const { otherCredits, releaseCreditNote, visibleReleaseFilters, releaseFilterFrom, releaseTypeLabel, artistMatchSummary } = await helpers;
  const release = {
    artistCredits: [
      { name: "V", role: "main", artistId: ARTIST_A },
      { name: "V", role: "main", artistId: ARTIST_B },
      { name: "Plain Credit", role: "main" },
    ],
    creditRoles: ["main"],
    collaboration: true,
  };
  assert.deepEqual(otherCredits(release, ARTIST_A).map((credit) => credit.artistId ?? null), [ARTIST_B, null], "a same-named homonym is still another artist");
  assert.equal(releaseCreditNote(release), "Collaboration");
  assert.equal(releaseCreditNote({ creditRoles: ["featured"], collaboration: true }), "Featured");
  assert.equal(releaseCreditNote({ creditRoles: ["main"], collaboration: false }), "");
  assert.deepEqual(visibleReleaseFilters({ all: 3, album: 2, ep: 0, single: 1, mixtape: 0, other: 0 }).map((filter) => filter.value), ["all", "album", "single"]);
  assert.deepEqual(visibleReleaseFilters({ all: 3, album: 3 }, "mixtape").map((filter) => filter.value), ["all", "album", "mixtape"]);
  assert.equal(releaseFilterFrom("nonsense"), "all");
  assert.equal(releaseFilterFrom("ep"), "ep");
  assert.equal(releaseTypeLabel("ep"), "EP");
  assert.equal(releaseTypeLabel("unknown"), "Release");
  assert.equal(
    artistMatchSummary({ match: { name: "방탄소년단", kind: "alias" }, releaseCount: 1, knownFor: ["Map of the Soul: 7"] }),
    "Also known as 방탄소년단 · 1 release · Map of the Soul: 7",
  );
  assert.equal(artistMatchSummary({ match: null, releaseCount: 0, knownFor: [] }), "0 releases");
});

test("several credits sharing one artistId are not a collaboration", async () => {
  const row = {
    albumId: "33333333-3333-4333-8333-333333333333",
    title: "Two Spellings",
    artistDisplayName: "이달의 소녀 (LOONA)",
    artistCredits: [
      { name: "이달의 소녀", role: "main", artistId: ARTIST_A },
      { name: "LOONA", role: "main", artistId: ARTIST_A.toUpperCase() },
    ],
    releaseType: "album",
    releaseYear: 2018,
    yearKey: 2018,
  };
  const card = releaseCard(row, ARTIST_A);
  assert.equal(card.collaboration, false);
  assert.deepEqual(card.creditRoles, ["main"]);
  assert.deepEqual(card.artistCredits.map((credit) => credit.name), ["이달의 소녀", "LOONA"], "credit wording and order are kept");
  assert.equal(hasOtherCreditedParty(row.artistCredits, ARTIST_A), false);

  const { otherCredits, releaseCreditNote } = await helpers;
  assert.deepEqual(otherCredits(card, ARTIST_A), [], "no 'with' line for the artist's own spellings");
  assert.equal(releaseCreditNote(card), "");

  const ownFeature = releaseCard({ ...row, artistCredits: [
    { name: "LOONA", role: "main", artistId: ARTIST_A },
    { name: "LOONA", role: "featured", artistId: ARTIST_A },
  ] }, ARTIST_A);
  assert.equal(ownFeature.collaboration, false);
  assert.deepEqual(ownFeature.creditRoles, ["main", "featured"]);
});

test("a collaboration needs another credited party, decided by identity only", async () => {
  const base = { albumId: "44444444-4444-4444-8444-444444444444", title: "Joint", artistDisplayName: "x", yearKey: -1 };
  const distinct = releaseCard({ ...base, artistCredits: [
    { name: "JAY-Z", role: "main", artistId: ARTIST_A },
    { name: "Kanye West", role: "main", artistId: ARTIST_B },
  ] }, ARTIST_A);
  assert.equal(distinct.collaboration, true);

  // Same display name, different identities: homonyms are never merged.
  const homonyms = releaseCard({ ...base, artistCredits: [
    { name: "V", role: "main", artistId: ARTIST_A },
    { name: "V", role: "main", artistId: ARTIST_B },
  ] }, ARTIST_A);
  assert.equal(homonyms.collaboration, true);

  // Duplicate own credits plus an unresolved credit: the unresolved credit is
  // a separately credited party and stays plain text without an artistId.
  const withUnresolved = releaseCard({ ...base, artistCredits: [
    { name: "LOONA", role: "main", artistId: ARTIST_A },
    { name: "이달의 소녀", role: "main", artistId: ARTIST_A },
    { name: "Unlinked Guest", role: "featured" },
  ] }, ARTIST_A);
  assert.equal(withUnresolved.collaboration, true);
  assert.deepEqual(withUnresolved.artistCredits[2], { name: "Unlinked Guest", role: "featured" });
  const { otherCredits, releaseCreditNote } = await helpers;
  assert.deepEqual(otherCredits(withUnresolved, ARTIST_A).map((credit) => credit.name), ["Unlinked Guest"]);
  assert.equal(releaseCreditNote(withUnresolved), "Collaboration");

  // An unresolved credit is not matched to this artist by name, even when
  // the spelling is identical; identity is never guessed.
  assert.equal(hasOtherCreditedParty([{ name: "V", artistId: ARTIST_A }, { name: "V" }], ARTIST_A), true);
  // Blank-named entries are not a party.
  assert.equal(hasOtherCreditedParty([{ name: "V", artistId: ARTIST_A }, { name: "" }], ARTIST_A), false);
  assert.equal(hasOtherCreditedParty(undefined, ARTIST_A), false);
  assert.equal(releaseCard({ ...base, artistCredits: [{ name: "Solo", role: "main", artistId: ARTIST_A }] }, ARTIST_A).collaboration, false);
});
