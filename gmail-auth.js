const { google } = require('googleapis');
const config = require('../config');
const db = require('../db/database');

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri
  );
}

function getAuthUrl(state) {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

async function handleCallback(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);

  db.prepare(`
    INSERT INTO oauth_tokens (service, access_token, refresh_token, token_expiry)
    VALUES ('gmail', ?, ?, ?)
    ON CONFLICT(service) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
      token_expiry = excluded.token_expiry
  `).run(tokens.access_token, tokens.refresh_token, tokens.expiry_date);

  return tokens;
}

function getClient() {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get('gmail');
  if (!row) return null;

  const client = createOAuth2Client();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.token_expiry,
  });

  // Auto-save refreshed tokens
  client.on('tokens', (tokens) => {
    db.prepare(`
      UPDATE oauth_tokens SET
        access_token = ?,
        refresh_token = COALESCE(?, refresh_token),
        token_expiry = ?
      WHERE service = 'gmail'
    `).run(tokens.access_token, tokens.refresh_token, tokens.expiry_date);
  });

  return client;
}

function isConnected() {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get('gmail');
  return !!row;
}

module.exports = { getAuthUrl, handleCallback, getClient, isConnected };
