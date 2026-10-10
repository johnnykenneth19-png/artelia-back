const rateLimit = require('express-rate-limit');

// General API traffic
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' } },
});

// Tight limiter for auth endpoints — brute-force protection
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' } },
});

// Very tight limiter for payment/offer-mutating endpoints
const sensitiveActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please try again shortly.', code: 'RATE_LIMITED' } },
});

module.exports = { apiLimiter, authLimiter, sensitiveActionLimiter };
