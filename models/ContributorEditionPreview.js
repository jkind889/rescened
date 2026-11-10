const crypto = require('node:crypto');
const mongoose = require('mongoose');
const candidateSchema = require('./schemas/providerEdition');
const schema = new mongoose.Schema({
  previewId: { type: String, default: () => crypto.randomUUID(), required: true, unique: true, immutable: true },
  ownerUserId: { type: String, required: true, maxlength: 128, immutable: true },
  candidate: { type: candidateSchema, required: true, immutable: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' });
module.exports = mongoose.models.ContributorEditionPreview || mongoose.model('ContributorEditionPreview', schema);
