const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const marketingService = require('../services/marketingService');
const { optionalAuthenticate } = require('../middleware/auth');

// Public newsletter signup (spec section 3: homepage "Newsletter signup").
// Admin-side management (subscriber list/export, campaigns) lives under /admin.
router.post('/newsletter/subscribe', optionalAuthenticate, asyncHandler(async (req, res) => {
  const data = await marketingService.subscribeNewsletter(req.body.email, req.user?.id ?? null);
  res.status(201).json({ data });
}));

router.post('/newsletter/unsubscribe', asyncHandler(async (req, res) => {
  await marketingService.unsubscribeNewsletter(req.body.email);
  res.status(204).send();
}));

module.exports = router;
