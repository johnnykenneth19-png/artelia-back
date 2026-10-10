const asyncHandler = require('../utils/asyncHandler');
const messageService = require('../services/messageService');
const AppError = require('../utils/AppError');

const listConversations = asyncHandler(async (req, res) => {
  const data = await messageService.listConversations(req.user.id);
  res.json({ data });
});

const getThread = asyncHandler(async (req, res) => {
  const data = await messageService.getThread(req.user.id, req.params.userId);
  res.json({ data });
});

const send = asyncHandler(async (req, res) => {
  const { recipientId, body, artworkId, orderId, offerId, commissionId, attachmentUrls } = req.body;
  if (!recipientId) throw new AppError('recipientId is required.', 422, 'VALIDATION_ERROR');
  const message = await messageService.send(req.user.id, recipientId, { body, artworkId, orderId, offerId, commissionId, attachmentUrls });
  res.status(201).json({ data: message });
});

const report = asyncHandler(async (req, res) => {
  const data = await messageService.report(req.params.id, req.user.id, req.body.reason);
  res.status(201).json({ data });
});

const blockUser = asyncHandler(async (req, res) => {
  await messageService.blockUser(req.user.id, req.params.userId);
  res.status(204).send();
});

const unblockUser = asyncHandler(async (req, res) => {
  await messageService.unblockUser(req.user.id, req.params.userId);
  res.status(204).send();
});

const listBlocked = asyncHandler(async (req, res) => {
  const data = await messageService.listBlocked(req.user.id);
  res.json({ data });
});

module.exports = { listConversations, getThread, send, report, blockUser, unblockUser, listBlocked };
