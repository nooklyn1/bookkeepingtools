const config = require('../config');
const db = require('../db/database');

const AUTH_URL = `${config.exact.baseUrl}/api/oauth2/auth`;
const TOKEN_URL = `${config.exact.baseUrl}/api/oauth2/token`;

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.exact.clientId,
    redirect_uri: config.exact.redirectUri,
    response_type: 'code',
    force_login: '0',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeToken(code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.exact.clientId,
      client_secret: config.exact.clientSecret,
      redirect_uri: config.exact.redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const tokens = await res.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  // Fetch current division
  const division = await fetchCurrentDivision(tokens.access_token);

  db.prepare(`
    INSERT INTO oauth_tokens (service, access_token, refresh_token, token_expiry, extra_data)
    VALUES ('exact', ?, ?, ?, ?)
    ON CONFLICT(service) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_expiry = excluded.token_expiry,
      extra_data = excluded.extra_data
  `).run(tokens.access_token, tokens.refresh_token, expiresAt, JSON.stringify({ division }));

  // Update in-memory cache
  tokenCache = { accessToken: tokens.access_token, expiresAt };

  return { ...tokens, division };
}

async function refreshToken() {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get('exact');
  if (!row || !row.refresh_token) throw new Error('No Exact Online refresh token');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      client_id: config.exact.clientId,
      client_secret: config.exact.clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const tokens = await res.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  db.prepare(`
    UPDATE oauth_tokens SET
      access_token = ?,
      refresh_token = ?,
      token_expiry = ?
    WHERE service = 'exact'
  `).run(tokens.access_token, tokens.refresh_token, expiresAt);

  return tokens;
}

// In-memory token cache to avoid redundant DB reads and concurrent refreshes
// Seed from DB on startup so server restarts don't cause unnecessary refresh attempts
let tokenCache = { accessToken: null, expiresAt: 0 };
try {
  const row = db.prepare('SELECT access_token, token_expiry FROM oauth_tokens WHERE service = ?').get('exact');
  if (row) {
    tokenCache = { accessToken: row.access_token, expiresAt: row.token_expiry };
  }
} catch (e) { /* ignore - DB may not be ready */ }
let refreshPromise = null;

async function getAccessToken() {
  // Return cached token if still valid (with 120s buffer)
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 120000) {
    return tokenCache.accessToken;
  }

  // If a refresh is already in progress, wait for it
  if (refreshPromise) {
    await refreshPromise;
    return tokenCache.accessToken;
  }

  const row = db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get('exact');
  if (!row) throw new Error('Exact Online not connected');

  // If DB token is still valid, cache and return it
  if (Date.now() < row.token_expiry - 120000) {
    tokenCache = { accessToken: row.access_token, expiresAt: row.token_expiry };
    return row.access_token;
  }

  // Refresh needed — use a single promise to prevent concurrent refreshes
  refreshPromise = refreshToken().then(tokens => {
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    tokenCache = { accessToken: tokens.access_token, expiresAt };
    refreshPromise = null;
    return tokens;
  }).catch(err => {
    refreshPromise = null;
    throw err;
  });

  const tokens = await refreshPromise;
  return tokens.access_token;
}

async function fetchCurrentDivision(accessToken) {
  const res = await fetch(`${config.exact.baseUrl}/api/v1/current/Me?$select=CurrentDivision`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`Failed to fetch division: ${res.status}`);
  const data = await res.json();
  return data.d.results[0].CurrentDivision;
}

function getDivision() {
  const row = db.prepare('SELECT extra_data FROM oauth_tokens WHERE service = ?').get('exact');
  if (!row || !row.extra_data) return null;
  return JSON.parse(row.extra_data).division;
}

function isConnected() {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE service = ?').get('exact');
  return !!row;
}

module.exports = { getAuthUrl, exchangeToken, getAccessToken, getDivision, isConnected };
