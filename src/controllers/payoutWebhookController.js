const asyncHandler = require('../utils/asyncHandler');
const payoutService = require('../services/payoutService');

// Same rationale as the payment webhook: mounted with a raw body parser
// so the provider's HMAC signature can be verified against the exact
// bytes sent, before any JSON parsing touches the payload.
const handleWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-paystack-signature'] || req.headers['x-webhook-signature'];
  const result = await payoutService.handleTransferWebhook(req.body.toString('utf8'), signature);
  res.status(200).json({ received: true, ...result });
});

module.exports = { handleWebhook };
