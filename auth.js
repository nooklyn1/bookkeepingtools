const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const gmailAuth = require('../auth/gmail-auth');
const exactAuth = require('../auth/exactonline-auth');

// Gmail OAuth
router.get('/gmail', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  res.redirect(gmailAuth.getAuthUrl(state));
});

router.get('/gmail/callback', async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.oauthState) {
    return res.status(403).send('Invalid OAuth state');
  }
  delete req.session.oauthState;

  try {
    await gmailAuth.handleCallback(req.query.code);
    res.redirect('/?flash=Gmail connected successfully');
  } catch (err) {
    console.error('Gmail auth error:', err);
    res.redirect('/?flash=Gmail auth failed');
  }
});

// Exact Online OAuth
router.get('/exact', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  res.redirect(exactAuth.getAuthUrl(state));
});

router.get('/exact/callback', async (req, res) => {
  if (!req.query.state || req.query.state !== req.session.oauthState) {
    return res.status(403).send('Invalid OAuth state');
  }
  delete req.session.oauthState;

  try {
    const result = await exactAuth.exchangeToken(req.query.code);
    res.redirect('/?flash=Exact Online connected (Division: ' + result.division + ')');
  } catch (err) {
    console.error('Exact auth error:', err);
    res.redirect('/?flash=Exact auth failed');
  }
});

module.exports = router;
