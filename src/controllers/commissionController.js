const asyncHandler = require('../utils/asyncHandler');
const commissionService = require('../services/commissionService');
const feeService = require('../services/feeService');
const artistService = require('../services/artistService');
const AppError = require('../utils/AppError');
const { supabaseAdmin } = require('../config/supabase');

const create = asyncHandler(async (req, res) => {
  const { artistId, description, referenceImages, preferredSize, mediumId, budget, currency, deadline } = req.body;
  if (!artistId || !description) throw new AppError('artistId and description are required.', 422, 'VALIDATION_ERROR');

  const { data: artistRow } = await supabaseAdmin.from('artist_profiles').select('id, status').eq('id', artistId).maybeSingle();
  if (!artistRow || artistRow.status !== 'approved') {
    throw new AppError('This artist is not currently accepting commissions.', 400, 'ARTIST_NOT_AVAILABLE');
  }

  // FEE GATEWAY: "commission_request"
  const charge = await feeService.getOrCreateCharge({
    feeTypeCode: 'commission_request',
    userId: req.user.id,
    relatedEntityType: 'commission_intent',
    relatedEntityId: artistId,
    artistId,
    baseAmount: budget,
    currency,
  });

  if (!feeService.isSettled(charge)) {
    throw Object.assign(new AppError('A fee must be paid before this commission request can be submitted.', 402, 'FEE_PAYMENT_REQUIRED'), { feeCharge: charge });
  }

  const commission = await commissionService.createRequest(req.user.id, {
    artistId, description, referenceImages, preferredSize, mediumId, budget, currency, deadline,
  });
  res.status(201).json({ data: commission });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await commissionService.listForBuyer(req.user.id);
  res.json({ data });
});

const listReceived = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');
  const data = await commissionService.listForArtist(profile.id);
  res.json({ data });
});

const getOne = asyncHandler(async (req, res) => {
  const { commission } = await commissionService.getForParticipant(req.params.id, req.user.id);
  res.json({ data: commission });
});

const propose = asyncHandler(async (req, res) => {
  const { agreedPrice, estimatedCompletion, message } = req.body;
  const commission = await commissionService.propose(req.params.id, req.user.id, { agreedPrice: parseFloat(agreedPrice), estimatedCompletion, message });
  res.json({ data: commission });
});

const accept = asyncHandler(async (req, res) => {
  const result = await commissionService.accept(req.params.id, req.user.id);
  res.json({ data: result.commission, order: result.order, authorizationUrl: result.authorizationUrl });
});

const reject = asyncHandler(async (req, res) => {
  const commission = await commissionService.reject(req.params.id, req.user.id, req.body.reason);
  res.json({ data: commission });
});

const markInProgress = asyncHandler(async (req, res) => {
  const commission = await commissionService.markInProgress(req.params.id, req.user.id);
  res.json({ data: commission });
});

const markDelivered = asyncHandler(async (req, res) => {
  const commission = await commissionService.markDelivered(req.params.id, req.user.id);
  res.json({ data: commission });
});

const markCompleted = asyncHandler(async (req, res) => {
  const commission = await commissionService.markCompleted(req.params.id, req.user.id);
  res.json({ data: commission });
});

const requestChanges = asyncHandler(async (req, res) => {
  const commission = await commissionService.requestChanges(req.params.id, req.user.id);
  res.json({ data: commission });
});

const addMessage = asyncHandler(async (req, res) => {
  const message = await commissionService.addMessage(req.params.id, req.user.id, req.body.message, req.body.attachmentUrl);
  res.status(201).json({ data: message });
});

const getThread = asyncHandler(async (req, res) => {
  const messages = await commissionService.getThread(req.params.id, req.user.id);
  res.json({ data: messages });
});

module.exports = {
  create, listMine, listReceived, getOne, propose, accept, reject,
  markInProgress, markDelivered, markCompleted, requestChanges, addMessage, getThread,
};
