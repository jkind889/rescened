const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Load the real pure client helpers without their browser-only API imports.
const helpers = (() => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/features/comments/comments.js"), "utf8")
    .split("async function failure(")[0]
    .replace(/^import .*;\n/gm, "");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
})();

function sampleThread() {
  return {
    commentCount: 4,
    nextCursor: "next",
    comments: [
      { commentId: "a", status: "visible", body: "A", replyCount: 2, replies: [{ commentId: "a1", parentCommentId: "a", status: "visible" }], repliesCursor: "ra" },
      { commentId: "b", status: "deleted_by_author", replyCount: 1, replies: [{ commentId: "b1", parentCommentId: "b", status: "visible" }], repliesCursor: null },
    ],
  };
}

test("only https URLs become links, without trailing punctuation", async () => {
  const { linkSegments } = await helpers;
  assert.deepEqual(linkSegments("See https://example.com/a?b=1. And http://plain.test"), [
    { type: "text", value: "See " },
    { type: "link", value: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
    { type: "text", value: ". And http://plain.test" },
  ]);
  assert.deepEqual(linkSegments("(https://x.test/path)"), [
    { type: "text", value: "(" },
    { type: "link", value: "https://x.test/path", href: "https://x.test/path" },
    { type: "text", value: ")" },
  ]);
  assert.deepEqual(linkSegments("javascript:alert(1) https://"), [{ type: "text", value: "javascript:alert(1) https://" }]);
});

test("thread updates add, merge, edit, and remove comments without duplicates", async () => {
  const { addComment, appendReplies, appendThreadPage, removeComment, updateComment } = await helpers;
  let thread = addComment(sampleThread(), { commentId: "c", status: "visible", body: "C" });
  assert.equal(thread.commentCount, 5);
  assert.deepEqual(thread.comments.at(-1).replies, []);
  thread = addComment(thread, { commentId: "a2", parentCommentId: "a", status: "visible" });
  assert.equal(thread.comments[0].replyCount, 3);
  assert.equal(addComment(thread, { commentId: "a2", parentCommentId: "a" }), thread, "a repeated add changes nothing");

  thread = appendReplies(thread, "a", { replies: [{ commentId: "a1b" }, { commentId: "a2" }], nextCursor: null });
  assert.deepEqual(thread.comments[0].replies.map((reply) => reply.commentId), ["a1", "a1b", "a2"]);
  assert.equal(thread.comments[0].repliesCursor, null);
  thread = appendThreadPage(thread, { comments: [{ commentId: "c" }, { commentId: "d" }], nextCursor: null });
  assert.deepEqual(thread.comments.map((comment) => comment.commentId), ["a", "b", "d", "c"]);
  assert.equal(thread.nextCursor, null);

  thread = updateComment(thread, { commentId: "a1", body: "edited", editedAt: "2026-10-25" });
  assert.equal(thread.comments[0].replies[0].body, "edited");
});

test("comments posted here stay last while older pages and replies load in", async () => {
  const { addComment, appendReplies, appendThreadPage } = await helpers;
  let thread = addComment(sampleThread(), { commentId: "mine", status: "visible" });
  thread = addComment(thread, { commentId: "my-reply", parentCommentId: "a", status: "visible" });
  thread = appendThreadPage(thread, { comments: [{ commentId: "older" }], nextCursor: "more" });
  assert.deepEqual(thread.comments.map((comment) => comment.commentId), ["a", "b", "older", "mine"]);
  thread = appendThreadPage(thread, { comments: [{ commentId: "oldest" }, { commentId: "mine" }], nextCursor: null });
  assert.deepEqual(thread.comments.map((comment) => comment.commentId), ["a", "b", "older", "oldest", "mine"]);
  thread = appendReplies(thread, "a", { replies: [{ commentId: "a1b" }, { commentId: "my-reply" }], nextCursor: null });
  assert.deepEqual(thread.comments[0].replies.map((reply) => reply.commentId), ["a1", "a1b", "my-reply"]);
});

test("deleting keeps tombstones that hold replies and drops empty ones", async () => {
  const { removeComment } = await helpers;
  const tombstoned = removeComment(sampleThread(), "a", "deleted_by_author");
  assert.deepEqual(Object.keys(tombstoned.comments[0]).sort(), ["commentId", "createdAt", "replies", "repliesCursor", "replyCount", "status"]);
  assert.equal(tombstoned.comments[0].status, "deleted_by_author");
  assert.equal(tombstoned.commentCount, 3);

  const lastReplyGone = removeComment(sampleThread(), "b1", "deleted");
  assert.deepEqual(lastReplyGone.comments.map((comment) => comment.commentId), ["a"], "an empty tombstone disappears");
  const replyGone = removeComment(sampleThread(), "a1", "deleted");
  assert.equal(replyGone.comments[0].replyCount, 1);
  assert.deepEqual(replyGone.comments[0].replies, []);
});

test("draft keys are scoped to the viewer, review, and thread", async () => {
  const { commentDraftKey } = await helpers;
  assert.equal(commentDraftKey("", "r"), "");
  assert.notEqual(commentDraftKey("u", "r"), commentDraftKey("u", "r", "t"));
  assert.notEqual(commentDraftKey("u", "r"), commentDraftKey("v", "r"));
});
