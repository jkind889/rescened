const { createHash } = require("node:crypto");
const AccountFence = require("../models/AccountFence");

function accountKey(userId) {
  return createHash("sha256").update(`rescened:account:${userId}`).digest("hex");
}

function options(session) {
  if (!session) throw new Error("Account lifecycle writes require a transaction session");
  return { session, upsert: true, returnDocument: "after", lean: true };
}

async function claimActiveAccount(userId, session) {
  const account = await AccountFence.findOneAndUpdate(
    { _id: accountKey(userId) },
    { $inc: { revision: 1 } },
    options(session),
  );
  return !account.deleted;
}

async function markAccountDeleted(userId, session) {
  await AccountFence.findOneAndUpdate(
    { _id: accountKey(userId) },
    { $set: { deleted: true }, $inc: { revision: 1 } },
    options(session),
  );
}

module.exports = { accountKey, claimActiveAccount, markAccountDeleted };
