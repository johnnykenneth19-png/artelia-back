const asyncHandler = require('../utils/asyncHandler');
const orderService = require('../services/orderService');
const paymentService = require('../services/paymentService');
const artistService = require('../services/artistService');
const AppError = require('../utils/AppError');

const checkout = asyncHandler(async (req, res) => {
  const { shippingAddress, billingAddress, discountCode } = req.body;
  const result = await orderService.createFromCart(req.user.id, { shippingAddress, billingAddress, discountCode });
  res.status(201).json({ data: result.order, authorizationUrl: result.authorizationUrl });
});

const listMine = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const result = await orderService.listMine(req.user.id, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getOne = asyncHandler(async (req, res) => {
  const order = await orderService.getMine(req.params.id, req.user.id);
  res.json({ data: order });
});

const cancel = asyncHandler(async (req, res) => {
  const order = await orderService.cancelMine(req.params.id, req.user.id);
  res.json({ data: order });
});

/**
 * Called by the frontend when the buyer lands back on our site after
 * the provider's checkout page. Never trusts query-string params from
 * that redirect — it asks the provider directly (see
 * paymentService.verifyAndFinalize) and only then reports status.
 */
const verifyPayment = asyncHandler(async (req, res) => {
  const result = await paymentService.verifyAndFinalize(req.params.id, req.user.id);
  res.json({ data: result });
});

const listForArtist = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');

  const { page = 1, pageSize = 20 } = req.query;
  const result = await orderService.listForArtist(profile.id, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

module.exports = { checkout, listMine, getOne, cancel, verifyPayment, listForArtist };
