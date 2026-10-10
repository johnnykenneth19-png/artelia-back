const asyncHandler = require('../utils/asyncHandler');
const cartService = require('../services/cartService');
const AppError = require('../utils/AppError');

const listMine = asyncHandler(async (req, res) => {
  const items = await cartService.listMine(req.user.id);
  const availableItems = items.filter((i) => i.isAvailable);
  const subtotal = availableItems.reduce((sum, i) => sum + Number(i.artworks.price), 0);
  res.json({ data: items, meta: { subtotal: Math.round(subtotal * 100) / 100, currency: availableItems[0]?.artworks.currency || null } });
});

const addItem = asyncHandler(async (req, res) => {
  const { artworkId } = req.body;
  if (!artworkId) throw new AppError('artworkId is required.', 422, 'VALIDATION_ERROR');
  const item = await cartService.addItem(req.user.id, artworkId);
  res.status(201).json({ data: item });
});

const removeItem = asyncHandler(async (req, res) => {
  await cartService.removeItem(req.user.id, req.params.artworkId);
  res.status(204).send();
});

const clear = asyncHandler(async (req, res) => {
  await cartService.clear(req.user.id);
  res.status(204).send();
});

module.exports = { listMine, addItem, removeItem, clear };
