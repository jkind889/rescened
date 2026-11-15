// Structured artist-credit rows for the correction form. These are the pure
// helpers behind it; the rendered form is covered by correctionCredits.browser.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/community/artistCredits.js"), "utf8");
const helpers = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const ARTIST_ID = "11111111-1111-4111-8111-111111111111";
const MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const strip = (rows) => rows.map(({ key, ...row }) => row);

test("a credit name containing a comma stays one credit", async () => {
  const { creditRowsFromCredits, creditsFromRows } = await helpers;
  const rows = creditRowsFromCredits([{ name: "Tyler, The Creator", role: "main", artistId: ARTIST_ID }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(creditsFromRows(rows), [{ name: "Tyler, The Creator", role: "main", artistId: ARTIST_ID }]);
});

test("rows keep order, role and identity, and the identity only while the name is unchanged", async () => {
  const { creditRowsFromCredits, creditsFromRows } = await helpers;
  const stored = [
    { name: "Beta", role: "featured", artistMbid: MBID },
    { name: "Tyler, The Creator", role: "main", artistId: ARTIST_ID, artistMbid: MBID },
    { name: "Gamma", role: "producer" },
  ];
  const rows = creditRowsFromCredits(stored);
  assert.deepEqual(creditsFromRows(rows), stored);

  const renamed = rows.map((row, index) => (index === 1 ? { ...row, name: "Tyler, the Creator (renamed)" } : row));
  assert.deepEqual(creditsFromRows(renamed)[1], { name: "Tyler, the Creator (renamed)", role: "main" });
  const rolechange = rows.map((row, index) => (index === 0 ? { ...row, role: " guest " } : row));
  assert.deepEqual(creditsFromRows(rolechange)[0], { name: "Beta", role: "guest", artistMbid: MBID }, "a role edit keeps the identity");
  assert.deepEqual(creditsFromRows([{ ...rows[2], name: "  Gamma  ", role: "  " }]), [{ name: "Gamma", role: "main" }]);
});

test("two credits with the same name keep their own identities", async () => {
  const { creditRowsFromCredits, creditsFromRows } = await helpers;
  const other = "22222222-2222-4222-8222-222222222222";
  const stored = [{ name: "Alex", role: "main", artistId: ARTIST_ID }, { name: "Alex", role: "featured", artistId: other }];
  assert.deepEqual(creditsFromRows(creditRowsFromCredits(stored)), stored);
});

test("rows have unique keys, and draft snapshots leave keys out", async () => {
  const { creditRowsFromCredits, creditRowsSnapshot } = await helpers;
  const credits = [{ name: "A", role: "main", artistId: ARTIST_ID }, { name: "B", role: "main" }];
  const first = creditRowsFromCredits(credits);
  assert.equal(new Set(first.map((row) => row.key)).size, 2);
  assert.deepEqual(creditRowsSnapshot(first), creditRowsSnapshot(creditRowsFromCredits(credits)), "keys never count as edits");
  assert.ok(creditRowsSnapshot(first).every((row) => !("key" in row)));
});

test("draft rows restore with identity; legacy or malformed credit drafts are ignored", async () => {
  const { creditRowsFromCredits, creditRowsFromDraft, creditRowsSnapshot, creditsFromRows } = await helpers;
  const rows = creditRowsFromCredits([{ name: "Tyler, The Creator", role: "main", artistId: ARTIST_ID }, { name: "New", role: "featured" }]);
  const stored = JSON.parse(JSON.stringify(creditRowsSnapshot(rows)));
  assert.deepEqual(strip(creditRowsFromDraft(stored)), strip(rows));
  assert.deepEqual(creditsFromRows(creditRowsFromDraft(stored)), creditsFromRows(rows));
  assert.equal(creditRowsFromDraft("Tyler, The Creator"), null, "the old comma-joined draft cannot be split reliably");
  assert.equal(creditRowsFromDraft([]), null);
  assert.equal(creditRowsFromDraft([{ role: "main" }]), null);
  assert.equal(creditRowsFromDraft(Array.from({ length: 21 }, (_, i) => ({ name: `Artist ${i + 1}` }))).length, 21, "a draft of a longer album keeps every row");
  assert.deepEqual(creditsFromRows(creditRowsFromDraft([{ name: "X", role: 7, identity: { name: "X", artistId: "  " } }])), [{ name: "X", role: "main" }]);
});

test("rows are validated before submission", async () => {
  const { creditRow, creditRowProblems } = await helpers;
  assert.deepEqual(creditRowProblems([creditRow({ name: "A" })]), []);
  assert.deepEqual(creditRowProblems([]), ["Add at least one artist credit."]);
  assert.deepEqual(creditRowProblems([creditRow({ name: "A" }), creditRow({ name: "  " })]), ["Artist 2 needs a name."]);
  assert.deepEqual(creditRowProblems([creditRow({ name: "x".repeat(201) })]), ["Artist 1 name must be 200 characters or fewer."]);
  assert.deepEqual(creditRowProblems([creditRow({ name: "A", role: "r".repeat(81) })]), ["Artist 1 role must be 80 characters or fewer."]);
  const tooMany = creditRowProblems(Array.from({ length: 21 }, () => creditRow({ name: "A" })));
  assert.equal(tooMany.length, 1);
  assert.match(tooMany[0], /at most 20 artist credits, and this form has 21/);
});

test("the correction form no longer uses the comma splitter", () => {
  const form = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/Community/CorrectionForm.jsx"), "utf8");
  assert.doesNotMatch(form, /creditsFromNames/);
  assert.doesNotMatch(source, /split\(","\)/);
});

test("an album with more than twenty credits loads every credit and is blocked, not truncated", async () => {
  const { creditRowsFromCredits, creditRowProblems, creditsFromRows, MAX_CREDIT_ROWS } = await helpers;
  const stored = Array.from({ length: MAX_CREDIT_ROWS + 1 }, (_, i) => ({ name: `Artist ${i + 1}`, role: i === 20 ? "featured" : "main", ...(i === 20 ? { artistId: ARTIST_ID } : {}) }));
  const rows = creditRowsFromCredits(stored);
  assert.equal(rows.length, 21, "no loaded credit is dropped");
  assert.deepEqual(creditsFromRows(rows), stored, "the last credit keeps its role and identity");
  assert.equal(creditRowProblems(rows).length, 1, "the submission limit is reported, so the credits are never sent truncated");
  assert.deepEqual(creditRowProblems(rows.slice(0, 20)), [], "only an explicit removal gets under the limit");
});
