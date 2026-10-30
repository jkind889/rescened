const express = require("express");
const { getAuth } = require("@clerk/express");
const { dataExportRateLimit } = require("./utils/rateLimit");
const { isDataExportEnabled } = require("./utils/serverConfig");
const { collectExport } = require("../lib/dataExport/collect");
const { DATASETS, FORMATS, serializeExport } = require("../lib/dataExport/serializers");

// Mounted at /profile/me/export, before /profile. See docs/DATA_EXPORT.md.
const router = express.Router();

function requireEnabled(req, res, next) {
  if (!isDataExportEnabled()) return res.status(503).json({ error: "Data export is not available.", code: "DATA_EXPORT_DISABLED" });
  next();
}

// Owner-only: the signed-in user exports their own data, whatever their
// profile's privacy setting.
function auth(req, res, next) {
  let userId = "";
  try { userId = getAuth(req).userId || ""; } catch { userId = ""; }
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId;
  next();
}

function invalidRequest(req, res) {
  return res.status(400).json({ error: "Choose reviews, listens, or boards as csv or json.", code: "INVALID_EXPORT_REQUEST" });
}

// Checked before the rate limit, so a malformed request does not spend an export.
function validateRequest(req, res, next) {
  const { dataset, format } = req.params;
  if (!DATASETS.includes(dataset) || !FORMATS.includes(format) || Object.keys(req.query || {}).length) return invalidRequest(req, res);
  next();
}

// Lets the settings page show the section only while exports are enabled,
// without spending an export.
router.get("/", requireEnabled, auth, (req, res) => res.json({ datasets: DATASETS, formats: FORMATS }));

router.get("/:dataset.:format", requireEnabled, auth, validateRequest, dataExportRateLimit, async (req, res) => {
  const { dataset, format } = req.params;
  try {
    const { contentType, body } = serializeExport(dataset, format, await collectExport(dataset, req.userId));
    res.set("Cache-Control", "no-store");
    res.set("Content-Type", contentType);
    res.send(body);
  } catch (error) {
    if (error.code === "EXPORT_TOO_LARGE") return res.status(413).json({ error: error.message, code: error.code });
    console.error("Data export failed", { dataset, format, error });
    res.status(500).json({ error: "Failed to build the export.", code: "EXPORT_FAILED" });
  }
});

// Any other path here, such as a dataset without a format, is also invalid.
router.use(requireEnabled, auth, invalidRequest);

module.exports = router;
