const asyncHandler = require('../utils/asyncHandler');
const reviewService = require('../services/reviewService');
const AppError = require('../utils/AppError');

const create = asyncHandler(async (req, res) => {
  const { orderId, artworkId, rating, packagingRating, deliveryRating, comment } = req.body;
  const review = await reviewService.create(req.user.id, { orderId, artworkId, rating, packagingRating, deliveryRating, comment });
  res.status(201).json({ data: review });
});

const listForArtwork = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const result = await reviewService.listForArtwork(req.params.artworkId, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const listForArtist = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const result = await reviewService.listForArtist(req.params.artistId, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const report = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const data = await reviewService.report(req.user.id, req.params.id, reason);
  res.status(201).json({ data });
});

module.exports = { create, listForArtwork, listForArtist, report };
