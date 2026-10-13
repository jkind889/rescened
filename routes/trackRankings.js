const express = require("express");
const { getAuth } = require("@clerk/express");
const { findAlbumByPublicId } = require("./utils/albumCatalog");
const { albumRankings, deleteRanking, normalizeRankingInput, requireTracklist, saveRanking } = require("./utils/trackRankings");
const { trackRankingMutationRateLimit } = require("./utils/rateLimit");

const router = express.Router();
function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function auth(req, res, next) { const userId = viewer(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
function fail(res, error, fallback) {
  res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.code && error.status ? { code: error.code } : {}) });
}

// Community standings for an album, plus the signed-in viewer's own ranking.
router.get("/album/:albumId", async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    res.json(await albumRankings(album, viewer(req)));
  } catch (error) { fail(res, error, "Failed to fetch track rankings"); }
});

router.put("/album/:albumId", auth, trackRankingMutationRateLimit, async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    requireTracklist(album);
    const rankedTrackIds = normalizeRankingInput(req.body, album);
    await saveRanking(req.userId, album, rankedTrackIds);
    res.json(await albumRankings(album, req.userId));
  } catch (error) { fail(res, error, "Failed to save track ranking"); }
});

router.delete("/album/:albumId", auth, trackRankingMutationRateLimit, async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    await deleteRanking(req.userId, album);
    res.json(await albumRankings(album, req.userId));
  } catch (error) { fail(res, error, "Failed to delete track ranking"); }
});

module.exports = router;
