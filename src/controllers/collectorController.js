const asyncHandler = require('../utils/asyncHandler');
const collectorService = require('../services/collectorService');
const AppError = require('../utils/AppError');

const becomeCollector = asyncHandler(async (req, res) => {
  const profile = await collectorService.becomeCollector(req.user.id);
  res.json({ data: profile });
});

const getMyCollection = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 24 } = req.query;
  const result = await collectorService.getMyCollection(req.user.id, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const listNotes = asyncHandler(async (req, res) => {
  const data = await collectorService.listNotes(req.user.id);
  res.json({ data });
});

const upsertNote = asyncHandler(async (req, res) => {
  const { note } = req.body;
  const data = await collectorService.upsertNote(req.user.id, req.params.artworkId, note);
  res.json({ data });
});

const removeNote = asyncHandler(async (req, res) => {
  await collectorService.removeNote(req.user.id, req.params.artworkId);
  res.status(204).send();
});

module.exports = { becomeCollector, getMyCollection, listNotes, upsertNote, removeNote };
