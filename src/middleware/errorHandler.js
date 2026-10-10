const config = require('../config');

// 404 handler — must be mounted after all routes.
function notFound(req, res, next) {
  res.status(404).json({ error: { message: 'Resource not found', code: 'NOT_FOUND' } });
}

// Final error handler — must be mounted last, with 4 args so Express
// recognizes it as an error middleware.
function errorHandler(err, req, res, next) {
  const statusCode = err.isOperational ? err.statusCode : 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.isOperational ? err.message : 'Something went wrong. Please try again.';

  // Log full detail server-side only. Replace with a real logger (pino/winston)
  // wired to your observability stack in production.
  if (!err.isOperational) {
    console.error('[UNHANDLED ERROR]', {
      path: req.originalUrl,
      method: req.method,
      message: err.message,
      stack: config.env === 'development' ? err.stack : undefined,
    });
  }

  res.status(statusCode).json({
    error: {
      message,
      code,
      ...(err.details ? { details: err.details } : {}),
      ...(err.feeCharge ? { feeCharge: err.feeCharge } : {}),
      ...(config.env === 'development' && !err.isOperational ? { stack: err.stack } : {}),
    },
  });
}

module.exports = { notFound, errorHandler };
