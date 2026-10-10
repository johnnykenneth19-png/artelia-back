const asyncHandler = require('../utils/asyncHandler');
const roomViewService = require('../services/roomViewService');
const AppError = require('../utils/AppError');

const submitRequest = asyncHandler(async (req, res) => {
  const { artworkId } = req.body;
  if (!artworkId) throw new AppError('artworkId is required.', 422, 'VALIDATION_ERROR');
  if (!req.file) throw new AppError('A room photo (field "image") is required.', 422, 'VALIDATION_ERROR');

  const data = await roomViewService.submitRequest(req.user.id, artworkId, req.file);
  res.status(201).json({
    data,
    note: 'Request received. Image compositing is not yet available — this request will remain pending until that service is integrated.',
  });
});

const getRequest = asyncHandler(async (req, res) => {
  const data = await roomViewService.getRequest(req.params.id, req.user.id);
  res.json({ data });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await roomViewService.listMine(req.user.id);
  res.json({ data });
});

module.exports = { submitRequest, getRequest, listMine };
