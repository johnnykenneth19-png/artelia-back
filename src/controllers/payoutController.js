const asyncHandler = require('../utils/asyncHandler');
const payoutService = require('../services/payoutService');
const artistService = require('../services/artistService');
const AppError = require('../utils/AppError');

const requestPayout = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const { amount, currency } = req.body;
  if (!amount || !currency) throw new AppError('An amount and currency are required.', 422, 'VALIDATION_ERROR');

  const result = await payoutService.requestPayout(profile.id, req.user.id, { amount: parseFloat(amount), currency });
  res.status(201).json({
    data: result.payout,
    message: result.feeCharged > 0
      ? `A withdrawal fee of ${result.feeCharged} ${currency} was applied. Net payout: ${result.payout.amount} ${currency}.`
      : 'Withdrawal requested.',
  });
});

const listMine = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');
  const data = await payoutService.listMine(profile.id);
  res.json({ data });
});

module.exports = { requestPayout, listMine };
