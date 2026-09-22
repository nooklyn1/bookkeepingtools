const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const config = require('../config');
const router = express.Router();

function createOAuth2Client() {
  return new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.loginRedirectUri
  );
}

router.get('/', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  const client = createOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'online',
    scope: ['https://www.googleapis.com/auth/userinfo.email'],
    prompt: 'select_account',
    state,
  });
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.oauthState) {
    return res.status(403).send('Invalid OAuth state');
  }
  delete req.session.oauthState;

  try {
    const client = createOAuth2Client();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    const email = data.email.toLowerCase();

    if (config.allowedEmails.length > 0 && !config.allowedEmails.includes(email)) {
      return res.status(403).send(`
        <h1>Access Denied</h1>
        <p>${email} is not authorized to access this application.</p>
        <a href="/login">Try another account</a>
      `);
    }

    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.status(500).send('Login failed');
      }
      req.session.user = { email, name: data.name, picture: data.picture };
      res.redirect('/');
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Login failed. Please try again.');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
