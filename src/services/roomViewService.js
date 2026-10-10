const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const uploadService = require('../services/uploadService');

/**
 * "VIEW ARTWORK IN ROOM" (spec section 37) — ARCHITECTURE ONLY, exactly
 * as the spec asks for: "For the first version, create the UI and
 * backend architecture so an AI/image-processing service can be
 * integrated later." This module deliberately does NOT composite the
 * artwork onto the room photo — there is no image-processing/AI service
 * wired into this codebase anywhere, and faking a result (e.g. just
 * returning the artwork image or the room image unchanged) would be
 * actively misleading. A request is accepted, stored, and left
 * `pending` forever until a real service is integrated; this is flagged
 * here and in the README, not silently stubbed.
 */

async function submitRequest(userId, artworkId, file) {
  const { data: artwork, error: artworkError } = await supabaseAdmin
    .from('artworks').select('id').eq('id', artworkId).eq('status', 'published').maybeSingle();
  if (artworkError || !artwork) throw new AppError('Artwork not found or not currently available.', 404, 'NOT_FOUND');

  const { storagePath } = await uploadService.uploadRoomImage(file, { userId });

  const { data, error } = await supabaseAdmin
    .from('room_view_requests')
    .insert({ user_id: userId, artwork_id: artworkId, room_image_url: storagePath, status: 'pending' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not submit room view request.', 500, 'INSERT_FAILED');
  return data;
}

async function getRequest(requestId, userId) {
  const { data, error } = await supabaseAdmin
    .from('room_view_requests').select('*').eq('id', requestId).eq('user_id', userId).maybeSingle();
  if (error) throw new AppError('Could not load request.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Request not found.', 404, 'NOT_FOUND');
  return data;
}

async function listMine(userId) {
  const { data, error } = await supabaseAdmin
    .from('room_view_requests').select('*, artworks(title, slug)').eq('user_id', userId).order('created_at', { ascending: false });
  if (error) throw new AppError('Could not load your requests.', 500, 'QUERY_FAILED');
  return data;
}

module.exports = { submitRequest, getRequest, listMine };
