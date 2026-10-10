const asyncHandler = require('../utils/asyncHandler');
const resaleService = require('../services/resaleService');
const orderService = require('../services/orderService');
const feeService = require('../services/feeService');
const AppError = require('../utils/AppError');

const listActive = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const result = await resaleService.listActive({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getOne = asyncHandler(async (req, res) => {
  const data = await resaleService.getActiveListing(req.params.id);
  res.json({ data });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await resaleService.listMine(req.user.id);
  res.json({ data });
});

const create = asyncHandler(async (req, res) => {
  const { artworkId, price, currency, artistRoyaltyPercentage } = req.body;
  if (!artworkId || !price || !currency) {
    throw new AppError('artworkId, price and currency are required.', 422, 'VALIDATION_ERROR');
  }

  // FEE GATEWAY: "resale_listing" — if admin has an active fee
  // configured for listing a resale, it must be settled first. If no
  // fee is configured, this returns null and listing proceeds free.
  const charge = await feeService.getOrCreateCharge({
    feeTypeCode: 'resale_listing',
    userId: req.user.id,
    relatedEntityType: 'artwork',
    relatedEntityId: artworkId,
    baseAmount: price,
    currency,
  });

  if (!feeService.isSettled(charge)) {
    throw Object.assign(
      new AppError('A resale listing fee must be paid before this artwork can be listed.', 402, 'FEE_PAYMENT_REQUIRED'),
      { feeCharge: charge }
    );
  }

  const listing = await resaleService.createListing(req.user.id, { artworkId, price, currency, artistRoyaltyPercentage });
  res.status(201).json({ data: listing });
});

const cancel = asyncHandler(async (req, res) => {
  const listing = await resaleService.cancelListing(req.params.id, req.user.id);
  res.json({ data: listing });
});

const buy = asyncHandler(async (req, res) => {
  const listing = await resaleService.getActiveListing(req.params.id);
  const result = await orderService.createFromResaleListing(listing, req.user.id);
  res.status(201).json({ data: result.order, authorizationUrl: result.authorizationUrl });
});

module.exports = { listActive, getOne, listMine, create, cancel, buy };
