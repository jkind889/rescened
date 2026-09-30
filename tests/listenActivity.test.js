const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Listen = require("../models/Listen");
const { getListenActivity } = require("../routes/utils/listenActivity");

test("listen activity exposes automatic/manual labels without private session metadata", async (t) => {
  const albumId = crypto.randomUUID();
  const rows = ["automatic", "manual", undefined].map((source) => ({
    listenId: crypto.randomUUID(), userId: "listener", source,
    listenedOn: "2026-09-29", createdAt: new Date("2026-09-29T12:00:00Z"),
    automaticSessionId: "private-session",
    catalogAlbum: { albumId, title: "Album", artistDisplayName: "Artist" },
  }));
  t.mock.method(Listen, "aggregate", async (pipeline) => {
    const projection = pipeline.at(-1).$project;
    assert.equal(projection.source, 1);
    assert.equal(projection.automaticSessionId, undefined);
    return rows;
  });

  const activity = await getListenActivity(["listener"], 10);
  assert.deepEqual(activity.map((item) => item.source), ["automatic", "manual", "manual"]);
  for (const item of activity) {
    assert.equal(item.type, "listen");
    assert.equal(item.album.albumId, albumId);
    assert.equal(item.automaticSessionId, undefined);
  }
});
