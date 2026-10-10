class AppError extends Error {
  /**
   * @param {string} message - safe to show to the end user
   * @param {number} statusCode
   * @param {string} [code] - machine-readable error code for the frontend
   */
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true; // distinguishes expected errors from bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
