const { z } = require('zod');

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
  fullName: z.string().min(2).max(120),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createArtworkSchema = z.object({
  title: z.string().min(2).max(200),
  slug: z.string().min(2).max(220).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens.'),
  description: z.string().max(5000).optional(),
  artist_statement: z.string().max(3000).optional(),
  category_id: z.string().uuid().optional(),
  medium_id: z.string().uuid().optional(),
  style_id: z.string().uuid().optional(),
  subject_id: z.string().uuid().optional(),
  materials: z.string().max(500).optional(),
  year_created: z.number().int().min(1000).max(new Date().getFullYear()).optional(),
  width_cm: z.number().positive().optional(),
  height_cm: z.number().positive().optional(),
  depth_cm: z.number().positive().optional(),
  weight_kg: z.number().positive().optional(),
  orientation: z.enum(['portrait', 'landscape', 'square', 'other']).optional(),
  is_framed: z.boolean().optional(),
  artwork_type: z.enum(['original', 'print', 'limited_edition']),
  edition_number: z.number().int().positive().optional(),
  edition_size: z.number().int().positive().optional(),
  price: z.number().positive('Price must be greater than zero.'),
  currency: z.enum(['NGN', 'USD', 'GBP', 'EUR']),
  location: z.string().max(200).optional(),
  country: z.string().max(120).optional(),
  condition: z.string().max(200).optional(),
  signature_info: z.string().max(500).optional(),
  copyright_info: z.string().max(500).optional(),
  offers_enabled: z.boolean().optional(),
});

const applyArtistSchema = z.object({
  artistName: z.string().min(2).max(150),
  slug: z.string().min(2).max(160).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers and hyphens.'),
  bio: z.string().max(3000).optional(),
  location: z.string().max(200).optional(),
  country: z.string().max(120).optional(),
  specialties: z.array(z.string()).optional(),
  mediums: z.array(z.string()).optional(),
  website: z.string().url().optional(),
});

// Same shape as createArtworkSchema but every field optional — used for
// PATCH /artworks/:id where an artist edits only a subset of fields.
const updateArtworkSchema = createArtworkSchema.partial();

const makeOfferSchema = z.object({
  artwork_id: z.string().uuid(),
  amount: z.number().positive(),
  currency: z.enum(['NGN', 'USD', 'GBP', 'EUR']),
});

module.exports = {
  registerSchema, loginSchema, createArtworkSchema, updateArtworkSchema, applyArtistSchema, makeOfferSchema,
};
