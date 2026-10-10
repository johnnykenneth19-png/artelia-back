const asyncHandler = require('../utils/asyncHandler');
const certificateService = require('../services/certificateService');

// Public — no auth. Returns only artwork/artist/edition fields, never
// anything about who owns the piece (spec section 21).
const verify = asyncHandler(async (req, res) => {
  const result = await certificateService.verifyByCertificateNumber(req.params.number);
  res.json({ data: result });
});

module.exports = { verify };
