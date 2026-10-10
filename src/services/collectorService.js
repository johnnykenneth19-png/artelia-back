const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * COLLECTOR ACCOUNTS (spec section 38) — "professional collector"
 * features on top of an ordinary buyer account: an explicit opt-in
 * (`buyer_profiles.is_collector`), a private collection view (owned
 * artworks + their certificates + provenance), and private notes.
 * Nothing here is ever exposed publicly — every query below is scoped
 * to the authenticated user's own id.
 */

async function becomeCollector(userId) {
  const { data, error } = await supabaseAdmin
    .from('buyer_profiles')
    .upsert({ user_id: userId, is_collector: true }, { onConflict: 'user_id' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not activate collector features.', 500, 'UPDATE_FAILED');
  return data;
}

/**
 * The buyer's private collection — every artwork they currently own
 * (`artworks.current_owner_user_id`, kept accurate across first sales
 * AND resales by certificateService.issue / resaleService.finalizeResale),
 * with its certificate and full provenance trail attached. This is
 * strictly private: ownership here is never exposed to anyone else.
 */
async function getMyCollection(userId, { page = 1, pageSize = 24 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: artworks, error, count } = await supabaseAdmin
    .from('artworks')
    .select('id, title, slug, price, currency, status, artwork_images(url, is_main), artist_profiles(artist_name, slug)', { count: 'exact' })
    .eq('current_owner_user_id', userId)
    .order('sold_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load your collection.', 500, 'QUERY_FAILED');

  const items = await Promise.all(artworks.map(async (artwork) => {
    const [{ data: certificate }, { data: provenance }, { data: note }] = await Promise.all([
      supabaseAdmin.from('artwork_certificates').select('*').eq('artwork_id', artwork.id).order('issued_at', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from('provenance_records').select('*').eq('artwork_id', artwork.id).order('event_date', { ascending: true }),
      supabaseAdmin.from('collector_notes').select('*').eq('artwork_id', artwork.id).eq('user_id', userId).maybeSingle(),
    ]);
    return { ...artwork, certificate: certificate ?? null, provenance: provenance ?? [], myNote: note ?? null };
  }));

  return { items, total: count, page, pageSize };
}

async function listNotes(userId) {
  const { data, error } = await supabaseAdmin
    .from('collector_notes').select('*, artworks(title, slug)').eq('user_id', userId).order('updated_at', { ascending: false });
  if (error) throw new AppError('Could not load notes.', 500, 'QUERY_FAILED');
  return data;
}

/** Only the current owner may annotate an artwork — a private note is meaningless (and potentially confusing) on a piece you don't own. */
async function upsertNote(userId, artworkId, note) {
  if (!note || !note.trim()) throw new AppError('Note text is required.', 422, 'VALIDATION_ERROR');

  const { data: artwork } = await supabaseAdmin.from('artworks').select('current_owner_user_id').eq('id', artworkId).maybeSingle();
  if (!artwork || artwork.current_owner_user_id !== userId) {
    throw new AppError('You can only add notes to artworks you own.', 403, 'NOT_OWNER');
  }

  const { data, error } = await supabaseAdmin
    .from('collector_notes')
    .upsert({ user_id: userId, artwork_id: artworkId, note, updated_at: new Date().toISOString() }, { onConflict: 'user_id,artwork_id' })
    .select('*')
    .single();

  if (error) throw new AppError('Could not save note.', 500, 'UPSERT_FAILED');
  return data;
}

async function removeNote(userId, artworkId) {
  const { error } = await supabaseAdmin.from('collector_notes').delete().eq('user_id', userId).eq('artwork_id', artworkId);
  if (error) throw new AppError('Could not remove note.', 500, 'DELETE_FAILED');
}

module.exports = { becomeCollector, getMyCollection, listNotes, upsertNote, removeNote };
