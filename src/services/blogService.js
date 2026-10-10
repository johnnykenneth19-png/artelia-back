const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');

/**
 * BLOG / EDITORIAL SERVICE (spec section 43). Not assigned to a specific
 * phase in the original build order, but it shares its CMS/marketing
 * nature with Phase 8's collections/exhibitions work, and `blog_posts`
 * already exists in schema.sql unused — built here rather than left
 * dangling.
 */

function slugify(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ---- Public ----

async function listPublished({ category, tag, page = 1, pageSize = 12 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from('blog_posts')
    .select('id, title, slug, excerpt, featured_image_url, category, tags, published_at, users:author_id(full_name)', { count: 'exact' })
    .eq('is_published', true)
    .order('published_at', { ascending: false })
    .range(from, to);

  if (category) query = query.eq('category', category);
  if (tag) query = query.contains('tags', [tag]);

  const { data, error, count } = await query;
  if (error) throw new AppError('Could not load articles.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function getPublishedBySlug(slug) {
  const { data, error } = await supabaseAdmin
    .from('blog_posts')
    .select('*, users:author_id(full_name)')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle();

  if (error) throw new AppError('Could not load article.', 500, 'QUERY_FAILED');
  if (!data) throw new AppError('Article not found.', 404, 'NOT_FOUND');
  return data;
}

// ---- Admin ----

async function listAll({ page = 1, pageSize = 30 } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabaseAdmin
    .from('blog_posts')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError('Could not load articles.', 500, 'QUERY_FAILED');
  return { items: data, total: count, page, pageSize };
}

async function create(authorId, { title, excerpt, body, featuredImageUrl, category, tags, seoTitle, seoDescription, isPublished = false }) {
  if (!title || title.trim().length < 3) throw new AppError('A title is required.', 422, 'VALIDATION_ERROR');

  const slug = slugify(title);
  const { data, error } = await supabaseAdmin
    .from('blog_posts')
    .insert({
      title, slug, excerpt: excerpt ?? null, body: body ?? null, featured_image_url: featuredImageUrl ?? null,
      author_id: authorId, category: category ?? null, tags: tags ?? [],
      seo_title: seoTitle ?? null, seo_description: seoDescription ?? null,
      is_published: isPublished, published_at: isPublished ? new Date().toISOString() : null,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') throw new AppError('An article with a similar title already exists.', 409, 'DUPLICATE_SLUG');
    throw new AppError('Could not create article.', 500, 'INSERT_FAILED');
  }
  return data;
}

async function update(postId, updates) {
  const patch = {};
  if (updates.title !== undefined) { patch.title = updates.title; patch.slug = slugify(updates.title); }
  for (const [key, col] of [
    ['excerpt', 'excerpt'], ['body', 'body'], ['featuredImageUrl', 'featured_image_url'],
    ['category', 'category'], ['tags', 'tags'], ['seoTitle', 'seo_title'], ['seoDescription', 'seo_description'],
  ]) {
    if (updates[key] !== undefined) patch[col] = updates[key];
  }
  if (updates.isPublished !== undefined) {
    patch.is_published = updates.isPublished;
    if (updates.isPublished) patch.published_at = new Date().toISOString();
  }

  const { data, error } = await supabaseAdmin.from('blog_posts').update(patch).eq('id', postId).select('*').single();
  if (error) throw new AppError('Could not update article.', 500, 'UPDATE_FAILED');
  return data;
}

async function remove(postId) {
  const { error } = await supabaseAdmin.from('blog_posts').delete().eq('id', postId);
  if (error) throw new AppError('Could not delete article.', 500, 'DELETE_FAILED');
}

module.exports = { listPublished, getPublishedBySlug, listAll, create, update, remove };
