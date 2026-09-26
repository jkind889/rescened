const express = require("express");
const { verifyWebhook } = require("@clerk/express/webhooks");

const { cleanupUserData } = require("../lib/listening/connections");

const router = express.Router();

async function handleWebhook(req, res, options = {}) {
  let event;
  try {
    event = await verifyWebhook(req, {
      signingSecret: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    return res.status(400).json({ error: "Webhook verification failed", code: "INVALID_WEBHOOK" });
  }
  if (event?.type !== "user.deleted") return res.status(200).json({ ok: true });
  const userId = typeof event?.data?.id === "string" ? event.data.id.trim() : "";
  if (!userId) return res.status(400).json({ error: "Webhook user is invalid", code: "INVALID_WEBHOOK" });
  try {
    const cleanup = typeof options?.cleanup === "function" ? options.cleanup : cleanupUserData;
    await cleanup(userId, options?.cleanupOptions || {});
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ error: "Account cleanup is unavailable", code: "CLEANUP_UNAVAILABLE" });
  }
}

// The parent mounts this router before express.json() so Clerk's verifier can
// authenticate the original request bytes. It also accepts Buffer bodies when
// a test or another embedding application mounts a raw parser itself.
router.post("/", handleWebhook);

module.exports = router;
module.exports.handleWebhook = handleWebhook;
