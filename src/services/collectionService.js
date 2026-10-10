const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * COLLECTION SERVICE (spec section 35) — curated art collections
 * ("African Contemporary", "Art Under ₦100,000", etc). A collection is
 * just a named, admin-curated set of artworks with its own SEO-friendly
 * slug and publish state — it never duplicates artwork data, only
 * references it via collection_artworks.
 */

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---- Public ----

async function listPublished({ page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('collections')
    .select('id, name, slug, description, cover_image_url, seo_title, seo_description, created_at', { count: 'exact' })
    .eq('is_published', true)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load collections.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getPublishedBySlug(slug) {
  const { data: collection, error } = await supabaseAdmin
    .from('collections')
    .select('*')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle();

  if (error) throw new AppError('Could not load collection.', 500, 'QUERY_FAILED');
  if (!collection) throw new AppError('Collection not found.', 404, 'NOT_FOUND');

  const { data: artworks, error: artworksError } = await supabaseAdmin
    .from('collection_artworks')
    .select('sort_order, artworks(id, title, slug, price, currency, status, artwork_images(url, is_main), artist_profiles(artist_name, slug))')
    .eq('collection_id', collection.id)
    .eq('artworks.status', 'published')
    .order('sort_order', { ascending: true });

  if (artworksError) throw new AppError('Could not load collection artworks.', 500, 'QUERY_FAILED');

  return { ...collection, artworks: artworks.filter((a) => a.artworks).map((a) => a.artworks) };
}

// ---- Admin ----

async function listAll({ page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('collections')
    .select('*, collection_artworks(count)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load collections.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function create(adminId, { name, description, coverImageUrl, seoTitle, seoDescription, isPublished = false }) {
  if (!name || name.trim().length < 2) throw new AppError('A collection name is required.', 422, 'VALIDATION_ERROR');

  const slug = slugify(name);
  const { data, error } = await supabaseAdmin
    .from('collections')
    .insert({
      name, slug, description: description ?? null, cover_image_url: coverImageUrl ?? null,
      seo_title: seoTitle ?? null, seo_description: seoDescription ?? null,
      is_published: isPublished, created_by: adminId,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('A collection with a similar name already exists.', 409, 'DUPLICATE_SLUG');
    throw new AppError('Could not create collection.', 500, 'INSERT_FAILED');
  }
  return data;
}

async function update(collectionId, updates) {
  const patch = {};
  if (updates.name !== undefined) { patch.name = updates.name; patch.slug = slugify(updates.name); }
  if (updates.description !== undefined) patch.description = updates.description;
  if (updates.coverImageUrl !== undefined) patch.cover_image_url = updates.coverImageUrl;
  if (updates.seoTitle !== undefined) patch.seo_title = updates.seoTitle;
  if (updates.seoDescription !== undefined) patch.seo_description = updates.seoDescription;
  if (updates.isPublished !== undefined) patch.is_published = updates.isPublished;

  const { data, error } = await supabaseAdmin.from('collections').update(patch).eq('id', collectionId).select('*').single();
  if (error) throw new AppError('Could not update collection.', 500, 'UPDATE_FAILED');
  return data;
}

async function remove(collectionId) {
  const { error } = await supabaseAdmin.from('collections').delete().eq('id', collectionId);
  if (error) throw new AppError('Could not delete collection.', 500, 'DELETE_FAILED');
}

async function addArtwork(collectionId, artworkId, sortOrder = 0) {
  const { data, error } = await supabaseAdmin
    .from('collection_artworks')
    .upsert({ collection_id: collectionId, artwork_id: artworkId, sort_order: sortOrder }, { onConflict: 'collection_id,artwork_id' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not add artwork to collection.', 500, 'INSERT_FAILED');
  return data;
}

async function removeArtwork(collectionId, artworkId) {
  const { error } = await supabaseAdmin
    .from('collection_artworks')
    .delete()
    .eq('collection_id', collectionId)
    .eq('artwork_id', artworkId);

  if (error) throw new AppError('Could not remove artwork from collection.', 500, 'DELETE_FAILED');
}

module.exports = { listPublished, getPublishedBySlug, listAll, create, update, remove, addArtwork, removeArtwork };
