require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET,
  allowedEmails: (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_REDIRECT_URI || 'https://bookkeeping.downpipes.nl/auth/gmail/callback',
  },
  exact: {
    clientId: process.env.EXACT_CLIENT_ID,
    clientSecret: process.env.EXACT_CLIENT_SECRET,
    redirectUri: process.env.EXACT_REDIRECT_URI || 'https://bookkeeping.downpipes.nl/auth/exact/callback',
    baseUrl: 'https://start.exactonline.nl',
  },
  loginRedirectUri: process.env.LOGIN_REDIRECT_URI || 'https://bookkeeping.downpipes.nl/login/callback',
};
