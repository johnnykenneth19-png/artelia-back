const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * EXHIBITION SERVICE (spec section 36) — virtual exhibitions. Same
 * curation model as collections (admin-selected artworks, own slug,
 * publish state) plus a date window and curator note. "Artists" on an
 * exhibition are derived from its artworks' artist_id — never stored
 * separately, so there is nothing to fall out of sync.
 *
 * This phase ships the CMS + browsing API. An interactive/3D viewer is
 * explicitly future work (spec: "design the system so interactive/3D
 * galleries can be added later") — not built here.
 */

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function hydrateArtworksAndArtists(exhibitionId) {
  const { data: rows, error } = await supabaseAdmin
    .from('exhibition_artworks')
    .select('artworks(id, title, slug, price, currency, status, artwork_images(url, is_main), artist_profiles(id, artist_name, slug, profile_image_url))')
    .eq('exhibition_id', exhibitionId);

  if (error) throw new AppError('Could not load exhibition artworks.', 500, 'QUERY_FAILED');

  const artworks = rows.filter((r) => r.artworks).map((r) => r.artworks);
  const artistsById = new Map();
  for (const artwork of artworks) {
    if (artwork.artist_profiles) artistsById.set(artwork.artist_profiles.id, artwork.artist_profiles);
  }
  return { artworks, artists: [...artistsById.values()] };
}

// ---- Public ----

async function listPublished({ page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('exhibitions')
    .select('id, title, slug, description, cover_image_url, start_date, end_date, curator_info', { count: 'exact' })
    .eq('is_published', true)
    .order('start_date', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load exhibitions.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getPublishedBySlug(slug) {
  const { data: exhibition, error } = await supabaseAdmin
    .from('exhibitions').select('*').eq('slug', slug).eq('is_published', true).maybeSingle();

  if (error) throw new AppError('Could not load exhibition.', 500, 'QUERY_FAILED');
  if (!exhibition) throw new AppError('Exhibition not found.', 404, 'NOT_FOUND');

  const { artworks, artists } = await hydrateArtworksAndArtists(exhibition.id);
  return { ...exhibition, artworks, artists };
}

// ---- Admin ----

async function listAll({ page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('exhibitions')
    .select('*, exhibition_artworks(count)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load exhibitions.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function create(adminId, { title, description, coverImageUrl, curatorInfo, startDate, endDate, isPublished = false }) {
  if (!title || title.trim().length < 2) throw new AppError('An exhibition title is required.', 422, 'VALIDATION_ERROR');

  const slug = slugify(title);
  const { data, error } = await supabaseAdmin
    .from('exhibitions')
    .insert({
      title, slug, description: description ?? null, cover_image_url: coverImageUrl ?? null,
      curator_info: curatorInfo ?? null, start_date: startDate ?? null, end_date: endDate ?? null,
      is_published: isPublished,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('An exhibition with a similar title already exists.', 409, 'DUPLICATE_SLUG');
    throw new AppError('Could not create exhibition.', 500, 'INSERT_FAILED');
  }
  return data;
}

async function update(exhibitionId, updates) {
  const patch = {};
  if (updates.title !== undefined) { patch.title = updates.title; patch.slug = slugify(updates.title); }
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.coverImageUrl !== undefined) patch.cover_image_url = updates.coverImageUrl;
  if (updates.curatorInfo !== undefined) patch.curator_info = updates.curatorInfo;
  if (updates.startDate !== undefined) patch.start_date = updates.startDate;
  if (updates.endDate !== undefined) patch.end_date = updates.endDate;
  if (updates.isPublished !== undefined) patch.is_published = updates.isPublished;

  const { data, error } = await supabaseAdmin.from('exhibitions').update(patch).eq('id', exhibitionId).select('*').single();
  if (error) throw new AppError('Could not update exhibition.', 500, 'UPDATE_FAILED');
  return data;
}

async function remove(exhibitionId) {
  const { error } = await supabaseAdmin.from('exhibitions').delete().eq('id', exhibitionId);
  if (error) throw new AppError('Could not delete exhibition.', 500, 'DELETE_FAILED');
}

async function addArtwork(exhibitionId, artworkId) {
  const { data, error } = await supabaseAdmin
    .from('exhibition_artworks')
    .upsert({ exhibition_id: exhibitionId, artwork_id: artworkId }, { onConflict: 'exhibition_id,artwork_id' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not add artwork to exhibition.', 500, 'INSERT_FAILED');
  return data;
}

async function removeArtwork(exhibitionId, artworkId) {
  const { error } = await supabaseAdmin
    .from('exhibition_artworks')
    .delete()
    .eq('exhibition_id', exhibitionId)
    .eq('artwork_id', artworkId);

  if (error) throw new AppError('Could not remove artwork from exhibition.', 500, 'DELETE_FAILED');
}

module.exports = { listPublished, getPublishedBySlug, listAll, create, update, remove, addArtwork, removeArtwork };
