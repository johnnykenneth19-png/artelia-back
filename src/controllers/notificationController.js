const asyncHandler = require('../utils/asyncHandler');
const notificationService = require('../services/notificationService');

const listMine = asyncHandler(async (req, res) => {
  const { unreadOnly, page = 1, pageSize = 30 } = req.query;
  const result = await notificationService.listMine(req.user.id, { unreadOnly: unreadOnly === 'true', page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const markRead = asyncHandler(async (req, res) => {
  const data = await notificationService.markRead(req.params.id, req.user.id);
  res.json({ data });
});

const markAllRead = asyncHandler(async (req, res) => {
  await notificationService.markAllRead(req.user.id);
  res.status(204).send();
});

module.exports = { listMine, markRead, markAllRead };
