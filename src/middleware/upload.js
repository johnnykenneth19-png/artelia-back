const multer = require('multer');

// Memory storage: files land in req.file(s).buffer, never written to local
// disk. uploadService then validates and forwards the buffer straight to
// Supabase Storage. A generous global cap here; per-type limits are
// enforced again inside uploadService (belt and suspenders).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

module.exports = {
  singleImage: upload.single('image'),
  multipleImages: upload.array('images', 10),
  singleDocument: upload.single('document'),
};
