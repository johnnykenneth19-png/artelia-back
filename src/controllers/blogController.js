const asyncHandler = require('../utils/asyncHandler');
const blogService = require('../services/blogService');

const list = asyncHandler(async (req, res) => {
  const { category, tag, page = 1, pageSize = 12 } = req.query;
  const result = await blogService.listPublished({ category, tag, page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getOne = asyncHandler(async (req, res) => {
  const data = await blogService.getPublishedBySlug(req.params.slug);
  res.json({ data });
});

module.exports = { list, getOne };
