const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/authService');

const register = asyncHandler(async (req, res) => {
  const { user } = await authService.register(req.body);
  res.status(201).json({
    data: { id: user.id, email: user.email, fullName: user.full_name },
    message: 'Account created. Please check your email to verify your address.',
  });
});

const login = asyncHandler(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.login(req.body);

  res.cookie('artelia_refresh', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.json({ data: { user, accessToken } });
});

const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.artelia_refresh;
  const { accessToken } = await authService.refresh(token);
  res.json({ data: { accessToken } });
});

const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.artelia_refresh;
  if (token) await authService.logout(token);
  res.clearCookie('artelia_refresh');
  res.json({ data: { success: true } });
});

module.exports = { register, login, refresh, logout };
