const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

// These four tables are small, change rarely, and are read on nearly
// every page load (filters, artwork forms) — prime candidates for a
// CDN/HTTP cache layer in front of this endpoint later (spec section 53).
// For now, straightforward reads; no admin write endpoints yet (Phase 8).

async function listAll() {
  const [{ data: categories, error: e1 }, { data: mediums, error: e2 }, { data: styles, error: e3 }, { data: subjects, error: e4 }] =
    await Promise.all([
      supabaseAdmin.from('categories').select('id, name, slug, parent_id').order('name'),
      supabaseAdmin.from('mediums').select('id, name, slug').order('name'),
      supabaseAdmin.from('styles').select('id, name, slug').order('name'),
      supabaseAdmin.from('subjects').select('id, name, slug').order('name'),
    ]);

  if (e1 || e2 || e3 || e4) throw new AppError('Could not load taxonomy data.', 500, 'QUERY_FAILED');

  return { categories, mediums, styles, subjects };
}

module.exports = { listAll };
