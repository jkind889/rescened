const assert = require("node:assert/strict");
const test = require("node:test");

test("frontend helpers state the change notice and only load biographies the API serves", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists/artists.js"), "utf8");
  const helpers = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  assert.equal(helpers.biographyChangeNotice({ shortened: false, edited: false }), "Excerpt");
  assert.equal(helpers.biographyChangeNotice({ shortened: true, edited: false }), "Excerpt, shortened");
  assert.equal(helpers.biographyChangeNotice({ shortened: true, edited: true }), "Excerpt, shortened, edited by Rescened moderators");
  assert.equal(helpers.biographyChangeNotice(null), "");
  assert.equal(helpers.biographyAdvertised({ features: { biography: true } }), true);
  assert.equal(helpers.biographyAdvertised({ features: { discography: true } }), false, "an older API without the capability loads nothing");
  assert.equal(helpers.biographyStateLabel("needs_review"), "Needs review");
  const component = fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists/ArtistBiography.jsx"), "utf8");
  for (const required of ["article.url", "article.revisionUrl", "license.url", "biographyChangeNotice({ shortened, edited })", 'rel="license', "<BiographyAttribution article={biography.article} license={biography.license}"]) assert.ok(component.includes(required), required);
  assert.equal(/musicbrainz|wikidata\.org|wikipedia\.org\/w\/api/i.test(component), false, "the page reads only Rescened");
});

test("moderator panel results are dropped after sign-out, user switch, or a newer request", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists/artists.js"), "utf8");
  const { createRequestGuard, correctionDraftFor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const guard = createRequestGuard();
  const first = guard.begin();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.begin();
  assert.deepEqual([guard.isCurrent(first), guard.isCurrent(second)], [false, true], "a newer request supersedes an older one");
  guard.invalidate();
  assert.equal(guard.isCurrent(second), false, "sign-out or unmount invalidates every pending result");
  assert.equal(correctionDraftFor({ manual: { text: "Corrected." }, accepted: { text: "Accepted." } }), "Corrected.");
  assert.equal(correctionDraftFor({ manual: null, accepted: { text: "Accepted." } }), "Accepted.", "a cleared correction falls back to the published text");
  assert.equal(correctionDraftFor(null), "");

  const panel = fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists/ArtistBiographyModeration.jsx"), "utf8");
  assert.match(panel, /if \(!isLoaded \|\| !isSignedIn \|\| !userId\) return null;/, "nothing renders without a signed-in user");
  assert.match(panel, /<ModerationPanel key=\{userId\}/, "the panel is remounted per user");
  assert.match(panel, /requestGuard\.invalidate\(\);[\s\S]*controller\.abort\(\)/, "unmount invalidates and aborts pending requests");
  for (const guarded of ["if (!guard.current.isCurrent(request.token)) return;\n      setDetail({ record: data.biography", "if (error.name === \"AbortError\" || !guard.current.isCurrent(request.token)) return;"]) {
    assert.equal(panel.split(guarded).length - 1, 2, `${guarded} guards both load and command results`);
  }
  assert.ok(panel.includes("setText(correctionDraftFor(data.biography));\n      setReason(\"\");\n      setMessage(\"Saved.\");"), "a successful command resyncs the correction box");
  assert.equal(panel.split("<BiographyAttribution").length - 1, 2, "published and candidate excerpts both carry full attribution");
});
