require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:4000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  security: {
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10),
  },

  payment: {
    provider: process.env.PAYMENT_PROVIDER || 'paystack',
    secretKey: process.env.PAYMENT_SECRET_KEY,
    publicKey: process.env.PAYMENT_PUBLIC_KEY,
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET,
  },

  storage: {
    artworksBucket: process.env.STORAGE_BUCKET_ARTWORKS || 'artelia-artworks',
    documentsBucket: process.env.STORAGE_BUCKET_DOCUMENTS || 'artelia-verification-docs',
    avatarsBucket: process.env.STORAGE_BUCKET_AVATARS || 'artelia-avatars',
  },

  platform: {
    defaultCommissionPercentage: parseFloat(process.env.DEFAULT_COMMISSION_PERCENTAGE || '15'),
    baseCurrency: process.env.BASE_CURRENCY || 'NGN',
    // How long an artwork stays RESERVED during checkout before it's released back to AVAILABLE.
    reservationHoldMinutes: 20,
  },
};
