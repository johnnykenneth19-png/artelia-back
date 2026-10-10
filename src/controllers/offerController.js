const asyncHandler = require('../utils/asyncHandler');
const offerService = require('../services/offerService');
const feeService = require('../services/feeService');
const artistService = require('../services/artistService');
const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

const create = asyncHandler(async (req, res) => {
  const { artworkId, amount, currency } = req.body;
  if (!artworkId || !amount || !currency) throw new AppError('artworkId, amount, and currency are required.', 422, 'VALIDATION_ERROR');

  const { data: artwork } = await supabaseAdmin.from('artworks').select('artist_id, category_id').eq('id', artworkId).maybeSingle();
  if (!artwork) throw new AppError('Artwork not found.', 404, 'NOT_FOUND');

  // FEE GATEWAY: "offer_submission" — resolved before the offer is
  // created; if an active fee exists and isn't settled, block with 402.
  const charge = await feeService.getOrCreateCharge({
    feeTypeCode: 'offer_submission',
    userId: req.user.id,
    relatedEntityType: 'offer_intent',
    relatedEntityId: artworkId, // one intent-charge per artwork per buyer session is acceptable here
    artistId: artwork?.artist_id,
    categoryId: artwork?.category_id,
    baseAmount: amount,
    currency,
  });

  if (!feeService.isSettled(charge)) {
    throw Object.assign(new AppError('A fee must be paid before this offer can be submitted.', 402, 'FEE_PAYMENT_REQUIRED'), { feeCharge: charge });
  }

  const offer = await offerService.createOffer(req.user.id, { artworkId, amount: parseFloat(amount), currency });
  res.status(201).json({ data: offer });
});

const listMine = asyncHandler(async (req, res) => {
  const data = await offerService.listForBuyer(req.user.id, { status: req.query.status });
  res.json({ data });
});

const listReceived = asyncHandler(async (req, res) => {
  const profile = await artistService.getProfileByUserId(req.user.id);
  if (!profile) throw new AppError('No artist profile found for this account.', 404, 'NOT_FOUND');
  const data = await offerService.listForArtist(profile.id, { status: req.query.status });
  res.json({ data });
});

const getOne = asyncHandler(async (req, res) => {
  const { offer } = await offerService.getForParticipant(req.params.id, req.user.id);
  res.json({ data: offer });
});

const accept = asyncHandler(async (req, res) => {
  const result = await offerService.accept(req.params.id, req.user.id);
  res.json({ data: result.offer, order: result.order, authorizationUrl: result.authorizationUrl });
});

const reject = asyncHandler(async (req, res) => {
  const offer = await offerService.reject(req.params.id, req.user.id);
  res.json({ data: offer });
});

const counter = asyncHandler(async (req, res) => {
  const { amount } = req.body;
  if (!amount) throw new AppError('A counteroffer amount is required.', 422, 'VALIDATION_ERROR');
  const offer = await offerService.counter(req.params.id, req.user.id, parseFloat(amount));
  res.status(201).json({ data: offer });
});

const cancel = asyncHandler(async (req, res) => {
  const offer = await offerService.cancel(req.params.id, req.user.id);
  res.json({ data: offer });
});

const addMessage = asyncHandler(async (req, res) => {
  const message = await offerService.addMessage(req.params.id, req.user.id, req.body.message);
  res.status(201).json({ data: message });
});

const getThread = asyncHandler(async (req, res) => {
  const messages = await offerService.getThread(req.params.id, req.user.id);
  res.json({ data: messages });
});

module.exports = { create, listMine, listReceived, getOne, accept, reject, counter, cancel, addMessage, getThread };
