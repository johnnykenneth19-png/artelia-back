const asyncHandler = require('../utils/asyncHandler');
const paymentService = require('../services/paymentService');

// Note: req.body is a raw Buffer here (see app.js — this route is mounted
// with express.raw() specifically so we can verify the provider's HMAC
// signature against the exact bytes they sent, before any parsing).
const handleWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'] || req.headers['x-webhook-signature'];
  const result = await paymentService.handleWebhook(req.body.toString('utf8'), signature);

  // Always 200 a validly-signed, already-processed event so the provider
  // stops retrying it — but a bad signature still throws (-> 401) above.
  res.status(200).json({ received: true, ...result });
});

module.exports = { handleWebhook };
