const asyncHandler = require('../utils/asyncHandler');
const collectionService = require('../services/collectionService');

const list = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const result = await collectionService.listPublished({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getOne = asyncHandler(async (req, res) => {
  const data = await collectionService.getPublishedBySlug(req.params.slug);
  res.json({ data });
});

module.exports = { list, getOne };
