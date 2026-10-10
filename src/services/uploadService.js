const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const config = require('../config');

// Never trust the client-reported mimetype alone for anything security
// sensitive, but it's an acceptable first filter alongside magic-byte
// checks (see validateFile) and Supabase Storage's own content-type
// enforcement on upload.
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB — high-res gallery photography
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

// Minimal magic-byte sniffing so a renamed .exe can't slip through as "image/jpeg".
const MAGIC_BYTES = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  // WEBP: 'RIFF'....'WEBP' — checked separately below.
};

function bufferMatchesSignature(buffer, mimetype) {
  if (mimetype === 'image/webp') {
    return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  }
  const sig = MAGIC_BYTES[mimetype];
  if (!sig) return false;
  return sig.every((byte, i) => buffer[i] === byte);
}

function validateFile(file, { allowedTypes, maxBytes }) {
  if (!allowedTypes.includes(file.mimetype)) {
    throw new AppError(`Unsupported file type: ${file.mimetype}.`, 415, 'UNSUPPORTED_FILE_TYPE');
  }
  if (file.size > maxBytes) {
    throw new AppError(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB limit.`, 413, 'FILE_TOO_LARGE');
  }
  if (!bufferMatchesSignature(file.buffer, file.mimetype)) {
    throw new AppError('File content does not match its declared type.', 415, 'FILE_SIGNATURE_MISMATCH');
  }
}

function extensionFor(mimetype) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[mimetype] || 'bin';
}

/**
 * Uploads one artwork image to the artworks bucket. Path is namespaced
 * by artist and artwork ID with a random filename so URLs can't be
 * guessed or enumerated, and the caller (artworkService.addImages) never
 * trusts a client-supplied storage path.
 */
async function uploadArtworkImage(file, { artistProfileId, artworkId }) {
  validateFile(file, { allowedTypes: ALLOWED_IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES });

  const filename = `${crypto.randomUUID()}.${extensionFor(file.mimetype)}`;
  const path = `${artistProfileId}/${artworkId}/${filename}`;

  const { error } = await supabaseAdmin.storage
    .from(config.storage.artworksBucket)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

  if (error) throw new AppError('Could not upload image.', 500, 'UPLOAD_FAILED');

  const { data: publicUrlData } = supabaseAdmin.storage.from(config.storage.artworksBucket).getPublicUrl(path);

  return {
    storagePath: path,
    publicUrl: publicUrlData.publicUrl,
    // TODO(Phase 3 cont.): generate a real resized thumbnail via an image
    // processing job; for now the frontend can request the full image with
    // Supabase's on-the-fly transform params (?width=400).
    thumbnailUrl: `${publicUrlData.publicUrl}?width=400`,
  };
}

/**
 * Uploads a restricted document (verification ID, proof of address) to a
 * PRIVATE bucket — no public URL is ever generated. Access happens only
 * via short-lived signed URLs issued to the owning artist or an admin
 * (see getSignedDocumentUrl), matching spec section 5's requirement to
 * protect sensitive files from unauthorized public access.
 */
async function uploadVerificationDocument(file, { userId, documentType }) {
  validateFile(file, { allowedTypes: ALLOWED_DOCUMENT_TYPES, maxBytes: MAX_DOCUMENT_BYTES });

  const filename = `${crypto.randomUUID()}.${extensionFor(file.mimetype)}`;
  const path = `${userId}/${documentType}/${filename}`;

  const { error } = await supabaseAdmin.storage
    .from(config.storage.documentsBucket)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

  if (error) throw new AppError('Could not upload document.', 500, 'UPLOAD_FAILED');
  return { storagePath: path };
}

/** Issues a time-limited signed URL for a private document — never a permanent public link. */
async function getSignedDocumentUrl(storagePath, expiresInSeconds = 300) {
  const { data, error } = await supabaseAdmin.storage
    .from(config.storage.documentsBucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error) throw new AppError('Could not generate document access link.', 500, 'SIGNED_URL_FAILED');
  return data.signedUrl;
}

/**
 * "View in Room" (spec section 37) — a photo of someone's own home is
 * at least as private as a verification document, so this goes in the
 * same PRIVATE bucket as uploadVerificationDocument, never the public
 * artworks bucket. Only roomViewService (and getSignedDocumentUrl
 * above, reused for retrieval) ever reads it back.
 */
async function uploadRoomImage(file, { userId }) {
  validateFile(file, { allowedTypes: ALLOWED_IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES });

  const filename = `${crypto.randomUUID()}.${extensionFor(file.mimetype)}`;
  const path = `${userId}/room-views/${filename}`;

  const { error } = await supabaseAdmin.storage
    .from(config.storage.documentsBucket)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

  if (error) throw new AppError('Could not upload room photo.', 500, 'UPLOAD_FAILED');
  return { storagePath: path };
}

module.exports = { uploadArtworkImage, uploadVerificationDocument, getSignedDocumentUrl, uploadRoomImage };
