const AppError = require('../utils/AppError');

/**
 * validate(schema) — parses req.body against a zod schema. On failure,
 * returns a 422 with field-level messages instead of letting bad data
 * reach a service/controller. Replaces req.body with the parsed
 * (type-coerced, stripped-of-unknown-keys) result.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      const err = new AppError('Validation failed.', 422, 'VALIDATION_ERROR');
      err.details = details;
      return next(err);
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate };
