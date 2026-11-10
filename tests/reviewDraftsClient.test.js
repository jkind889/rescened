const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const helpers = import("../frontend/src/features/reviews/reviewDrafts.js");
const albumId = "11111111-1111-4111-8111-111111111111";
const requestKey = "22222222-2222-4222-8222-222222222222";
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("review drafts are private to the viewer and album", async () => {
  const { reviewDraftKey } = await helpers;
  assert.equal(reviewDraftKey("", albumId), "");
  assert.equal(reviewDraftKey("viewer", ""), "");
  assert.notEqual(reviewDraftKey("viewer", albumId), reviewDraftKey("other", albumId));
  assert.notEqual(reviewDraftKey("viewer", albumId), reviewDraftKey("viewer", "other"));
});

test("review validation preserves the required text, 300-character and half-star contract", async () => {
  const { reviewValidationMessage } = await helpers;
  for (const rating of [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
    assert.equal(reviewValidationMessage({ rating, reviewText: "x".repeat(300) }), "");
  }
  for (const rating of ["", 0, 0.5, 3.2, 5.5, "invalid", Infinity]) {
    assert.match(reviewValidationMessage({ rating, reviewText: "Review" }), /rating/);
  }
  assert.match(reviewValidationMessage({ rating: 4, reviewText: " \n " }), /Write a review/);
  assert.match(reviewValidationMessage({ rating: 4, reviewText: "x".repeat(301) }), /300/);
});

test("closing and returning restores a draft; publishing clears it", async () => {
  const { readReviewDraft, saveReviewDraft } = await helpers;
  const store = storage();
  const draft = { rating: "4.5", reviewText: "  Keep my words.  ", request: null };
  assert.equal(saveReviewDraft(store, "key", draft), true);
  assert.deepEqual(readReviewDraft(store, "key", albumId), draft);
  assert.equal(saveReviewDraft(store, "key", { rating: "", reviewText: "", request: null }), true);
  assert.equal(store.getItem("key"), null);
});

test("an uncertain submission restores its exact original request instead of a changed draft", async () => {
  const { readReviewDraft, saveReviewDraft } = await helpers;
  const store = storage();
  const request = { key: requestKey, body: { albumId, rating: 3.5, reviewText: "Original review" } };
  saveReviewDraft(store, "key", { rating: "5", reviewText: "Changed after sending", request });
  assert.deepEqual(readReviewDraft(store, "key", albumId), { rating: "3.5", reviewText: "Original review", request });
  assert.equal(readReviewDraft(store, "key", "another-album").request, null);
});

test("corrupt or unavailable browser storage never blocks writing", async () => {
  const { readReviewDraft, saveReviewDraft } = await helpers;
  const store = storage();
  store.setItem("key", "not json");
  const empty = { rating: "", reviewText: "", request: null };
  assert.deepEqual(readReviewDraft(store, "key", albumId), empty);
  assert.deepEqual(readReviewDraft(null, "key", albumId), empty);
  assert.equal(saveReviewDraft(null, "key", empty), false);
  store.setItem("key", JSON.stringify({ rating: 4, reviewText: {} }));
  assert.deepEqual(readReviewDraft(store, "key", albumId), empty);
  store.setItem("key", JSON.stringify({ rating: "4", reviewText: "x".repeat(500), request: { key: "bad" } }));
  const restored = readReviewDraft(store, "key", albumId);
  assert.equal(restored.reviewText.length, 300);
  assert.equal(restored.request, null);
});

test("the album uses an inline, account-scoped composer and preserves the home shortcut", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/AlbumDetail.jsx"), "utf8");
  assert.doesNotMatch(source, /isReviewModalOpen|setIsReviewModalOpen/);
  assert.match(source, /key=\{`\$\{userId\}:\$\{albumId\}`\}/);
  assert.match(source, /openRequestKey !== location\.key/);
  assert.match(source, /aria-controls="album-review-composer"/);
  assert.match(source, /activeViewerRef\.current !== userId/);
  assert.match(source, /reviewPageGenerationRef\.current !== pageGeneration/);
});

test("a stale success or rejection cannot replace a newer saved draft", async () => {
  const { saveReviewDraft, readReviewDraft, settleReviewDraft } = await helpers;
  const store = storage();
  const pending = { rating: "4", reviewText: "First review", request: { key: requestKey, body: { albumId, rating: 4, reviewText: "First review" } } };
  saveReviewDraft(store, "key", pending);
  assert.equal(settleReviewDraft(store, "key", requestKey, { rating: "", reviewText: "", request: null }), true);
  const next = { rating: "5", reviewText: "My next draft", request: null };
  saveReviewDraft(store, "key", next);
  assert.equal(settleReviewDraft(store, "key", requestKey, { rating: "", reviewText: "", request: null }), false);
  assert.equal(settleReviewDraft(store, "key", requestKey, { ...pending, request: null }), false);
  assert.deepEqual(readReviewDraft(store, "key", albumId), next);
});

test("the real submit handler ignores an abandoned completion after a remounted retry and newer draft", async () => {
  const { readReviewDraft, saveReviewDraft, settleReviewDraft, reviewValidationMessage } = await helpers;
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/ReviewForm.jsx"), "utf8");
  // Exercise the actual component's submit closures without a DOM dependency.
  const handlers = source.slice(source.indexOf("    function updateDraft(next) {"), source.indexOf("\n    return ("));
  const makeHandler = new Function("context", `const { draft, reviewText, request, album, numericRating, key, draftStorage, saveReviewDraft, settleReviewDraft, reviewValidationMessage, submittingRef, mountedRef, activeRequestRef, setDraft, setIsDraftSaved, setIsSubmitting, setSubmitError, onAddReview, onSubmitted, crypto } = context; ${handlers}; return handleSubmit;`);
  const store = storage();
  let resolveOriginal;
  const firstResponse = new Promise((resolve) => { resolveOriginal = resolve; });
  const calls = [];
  function composer(draft, response) {
    const mountedRef = { current: true };
    let submitted = 0;
    const context = { draft, reviewText: draft.reviewText, request: draft.request, album: { albumId }, numericRating: Number(draft.rating), key: "key",
      draftStorage: () => store, saveReviewDraft, settleReviewDraft, reviewValidationMessage, mountedRef,
      submittingRef: { current: false }, activeRequestRef: { current: null },
      setDraft() {}, setIsDraftSaved() {}, setIsSubmitting() {}, setSubmitError() {},
      onAddReview(body, key) { calls.push({ body, key }); return response; }, onSubmitted() { submitted++; },
      crypto: { randomUUID: () => requestKey },
    };
    return { submit: makeHandler(context), mountedRef, get submitted() { return submitted; } };
  }
  const original = composer({ rating: "4", reviewText: "First review", request: null }, firstResponse);
  const pendingOriginal = original.submit({ preventDefault() {} });
  original.mountedRef.current = false; // Navigation unmounts the original form.
  const remounted = composer(readReviewDraft(store, "key", albumId), Promise.resolve(true));
  await remounted.submit({ preventDefault() {} });
  assert.equal(remounted.submitted, 1);
  assert.deepEqual(calls[0], calls[1]);
  const next = { rating: "5", reviewText: "Keep this newer draft", request: null };
  saveReviewDraft(store, "key", next);
  resolveOriginal(true);
  await pendingOriginal;
  assert.equal(original.submitted, 0, "the late response must not close the current composer");
  assert.deepEqual(readReviewDraft(store, "key", albumId), next);
});
