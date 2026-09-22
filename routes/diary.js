const express = require("express");
const { getAuth } = require("@clerk/express");
const { diaryMutationRateLimit } = require("./utils/rateLimit");
const { fields } = require("./utils/diaryValidation");
const { createListen, updateListen, deleteListen, listListens } = require("./utils/listeningDiary");

const router = express.Router();
router.use((req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId;
  next();
});

function errorResponse(res, error) {
  return res.status(error.status || 500).json({
    error: error.status ? error.message : "Failed to process diary request",
    code: error.status ? error.code : "DIARY_REQUEST_FAILED",
  });
}

router.get("/", async (req, res) => {
  try { res.json(await listListens(req.userId, req.query)); }
  catch (error) { errorResponse(res, error); }
});
router.post("/", diaryMutationRateLimit, async (req, res) => {
  try {
    const result = await createListen(req.userId, req.body, req.get("Idempotency-Key"));
    res.status(result.created ? 201 : 200).json(result.listen);
  } catch (error) { errorResponse(res, error); }
});
router.patch("/:listenId", diaryMutationRateLimit, async (req, res) => {
  try { res.json(await updateListen(req.userId, req.params.listenId, req.body)); }
  catch (error) { errorResponse(res, error); }
});
router.delete("/:listenId", diaryMutationRateLimit, async (req, res) => {
  try {
    fields(req.body === undefined ? {} : req.body, []);
    await deleteListen(req.userId, req.params.listenId);
    res.json({ message: "Listen deleted" });
  } catch (error) { errorResponse(res, error); }
});

module.exports = router;
