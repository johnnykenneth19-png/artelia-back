const asyncHandler = require('../utils/asyncHandler');
const wishlistService = require('../services/wishlistService');
const AppError = require('../utils/AppError');

const listMine = asyncHandler(async (req, res) => {
  const data = await wishlistService.listMine(req.user.id);
  res.json({ data });
});

const create = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) throw new AppError('A wishlist name is required.', 422, 'VALIDATION_ERROR');
  const wishlist = await wishlistService.createWishlist(req.user.id, name);
  res.status(201).json({ data: wishlist });
});

const addItem = asyncHandler(async (req, res) => {
  let { wishlistId } = req.body;
  if (!wishlistId) {
    const defaultList = await wishlistService.getOrCreateDefault(req.user.id);
    wishlistId = defaultList.id;
  }
  const item = await wishlistService.addItem(req.user.id, wishlistId, req.params.artworkId);
  res.status(201).json({ data: item });
});

const removeItem = asyncHandler(async (req, res) => {
  const { wishlistId } = req.query;
  const targetWishlistId = wishlistId || (await wishlistService.getOrCreateDefault(req.user.id)).id;
  await wishlistService.removeItem(req.user.id, targetWishlistId, req.params.artworkId);
  res.status(204).send();
});

const share = asyncHandler(async (req, res) => {
  const wishlist = await wishlistService.enableSharing(req.user.id, req.params.id);
  res.json({ data: wishlist });
});

const getShared = asyncHandler(async (req, res) => {
  const wishlist = await wishlistService.getBySharedToken(req.params.token);
  res.json({ data: wishlist });
});

module.exports = { listMine, create, addItem, removeItem, share, getShared };
