const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const AlbumSubmission = require("../models/AlbumSubmission");
const { getSuggestionActivity } = require("../routes/utils/suggestionActivity");
const { compareActivity } = require("../lib/reviewComments/activity");

test("approved suggestion activity is an allowlisted public event, never submission detail", async (t) => {
  const submissionId = crypto.randomUUID();
  const albumId = crypto.randomUUID();
  const approvedAt = new Date("2026-11-01T12:00:00Z");
  t.mock.method(AlbumSubmission, "aggregate", async (pipeline) => {
    assert.deepEqual(pipeline[0].$match.submittedByUserId, { $in: ["contributor"] });
    assert.equal(pipeline[0].$match.status, "approved");
    assert.deepEqual(pipeline[0].$match.approvedAt, { $type: "date" });
    assert.ok(pipeline.findIndex((stage) => stage.$unwind) < pipeline.findIndex((stage) => stage.$limit));
    const projection = pipeline.at(-1).$project;
    assert.equal(projection.moderationHistory, undefined);
    assert.equal(projection.proposedMetadata, undefined);
    return [{
      submissionId, submittedByUserId: "contributor", status: "approved", approvedAt,
      approvalPublicationType: "catalog_corrected",
      approvedAlbumCatalogId: { albumId, title: "Current title", artistDisplayName: "Artist" },
      moderationHistory: [{ actorUserId: "private-moderator", reason: "private reason" }],
      supportingSources: [{ note: "private source" }], proposedChanges: { title: "Unapplied title" },
      revisions: [{ proposedMetadata: { title: "private revision" } }],
    }];
  });
  const [item] = await getSuggestionActivity(["contributor"], 20);
  assert.deepEqual(Object.keys(item).sort(), ["album", "createdAt", "id", "publicationType", "submissionId", "type", "userId"]);
  assert.equal(item.id, `suggestion:${submissionId}`);
  assert.equal(item.type, "suggestion_approved");
  assert.equal(item.userId, "contributor");
  assert.deepEqual(item.createdAt, approvedAt);
  assert.equal(item.publicationType, "catalog_corrected");
  assert.equal(item.album.albumId, albumId);
  assert.equal(item.album.title, "Current title");
  assert.equal(JSON.stringify(item).includes("private"), false);
});

test("empty suggestion actor sets skip persistence", async (t) => {
  t.mock.method(AlbumSubmission, "aggregate", () => assert.fail("No query expected"));
  assert.deepEqual(await getSuggestionActivity([], 20), []);
});

test("approval ties use public IDs after existing activity types", () => {
  const createdAt = new Date("2026-11-01T12:00:00Z");
  const entries = [
    { id: "suggestion:aaa", type: "suggestion_approved", createdAt },
    { id: "comment:aaa", type: "review_comment", createdAt },
    { id: "listen", type: "listen", createdAt },
    { id: "suggestion:bbb", type: "suggestion_approved", createdAt },
    { id: "review", type: "review", createdAt },
    { id: "comment:bbb", type: "comment_reply", createdAt },
  ];
  assert.deepEqual(entries.sort(compareActivity).map((row) => row.id), [
    "review", "listen", "comment:bbb", "comment:aaa", "suggestion:bbb", "suggestion:aaa",
  ]);
});

test("approval copy distinguishes publication outcomes and never labels the contributor as moderator", async () => {
  const { suggestionActivityLabels } = await import("../frontend/src/utils/activityLabels.js");
  const expected = {
    catalog_created: ["Album suggestion approved", "contributed"],
    catalog_linked: ["Suggestion approved", "had a suggestion approved for"],
    catalog_corrected: ["Correction approved", "contributed a correction to"],
    genres_updated: ["Genre suggestion approved", "contributed genre updates to"],
  };
  for (const [publicationType, [label, action]] of Object.entries(expected)) {
    assert.deepEqual(suggestionActivityLabels({ type: "suggestion_approved", publicationType }), { label, action });
  }
  assert.equal(suggestionActivityLabels({ type: "review" }), null);
  assert.equal(suggestionActivityLabels({ type: "suggestion_approved" }).label, "Suggestion approved");
});
