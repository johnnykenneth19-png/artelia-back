const asyncHandler = require('../utils/asyncHandler');
const galleryService = require('../services/galleryService');
const AppError = require('../utils/AppError');

const apply = asyncHandler(async (req, res) => {
  const gallery = await galleryService.apply(req.user.id, req.body);
  res.status(201).json({ data: gallery, message: 'Application submitted. Our team will review it and follow up on next steps.' });
});

const getMine = asyncHandler(async (req, res) => {
  const data = await galleryService.getMine(req.user.id);
  res.json({ data });
});

const listApproved = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 24 } = req.query;
  const result = await galleryService.listApproved({ page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getPublic = asyncHandler(async (req, res) => {
  const data = await galleryService.getPublicBySlug(req.params.slug);
  res.json({ data });
});

const updateProfile = asyncHandler(async (req, res) => {
  const data = await galleryService.updateProfile(req.params.id, req.user.id, req.body);
  res.json({ data });
});

const listMembers = asyncHandler(async (req, res) => {
  const data = await galleryService.listMembers(req.params.id, req.user.id);
  res.json({ data });
});

const inviteMember = asyncHandler(async (req, res) => {
  const { email, role } = req.body;
  if (!email) throw new AppError('An email is required.', 422, 'VALIDATION_ERROR');
  const data = await galleryService.inviteMember(req.params.id, req.user.id, { email, role });
  res.status(201).json({ data });
});

const updateMemberRole = asyncHandler(async (req, res) => {
  const data = await galleryService.updateMemberRole(req.params.id, req.user.id, req.params.memberId, req.body.role);
  res.json({ data });
});

const removeMember = asyncHandler(async (req, res) => {
  await galleryService.removeMember(req.params.id, req.user.id, req.params.memberId);
  res.status(204).send();
});

const joinAsArtist = asyncHandler(async (req, res) => {
  const data = await galleryService.joinAsArtist(req.user.id, req.params.id);
  res.json({ data });
});

const leaveGallery = asyncHandler(async (req, res) => {
  const data = await galleryService.leaveGallery(req.user.id);
  res.json({ data });
});

const listArtists = asyncHandler(async (req, res) => {
  const data = await galleryService.listArtists(req.params.id);
  res.json({ data });
});

const listInventory = asyncHandler(async (req, res) => {
  const { page = 1, pageSize = 24 } = req.query;
  const result = await galleryService.listInventory(req.params.id, req.user.id, { page: parseInt(page, 10), pageSize: parseInt(pageSize, 10) });
  res.json({ data: result.items, meta: { total: result.total, page: result.page, pageSize: result.pageSize } });
});

const getAnalytics = asyncHandler(async (req, res) => {
  const data = await galleryService.getAnalytics(req.params.id, req.user.id);
  res.json({ data });
});

module.exports = {
  apply, getMine, listApproved, getPublic, updateProfile,
  listMembers, inviteMember, updateMemberRole, removeMember,
  joinAsArtist, leaveGallery, listArtists, listInventory, getAnalytics,
};
