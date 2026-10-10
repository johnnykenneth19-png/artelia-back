// Wraps async route handlers so rejected promises reach errorHandler
// instead of crashing the process or hanging the request.
module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
