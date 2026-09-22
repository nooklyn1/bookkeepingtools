const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

if (!config.sessionSecret) {
  console.error('SESSION_SECRET environment variable is required. Set it in your .env file.');
  process.exit(1);
}

// Initialize database (runs schema)
require('./db/database');

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const sessionsDb = new Database(path.join(__dirname, '..', 'data', 'sessions.db'));

const { csrfSync } = require('csrf-sync');
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => {
    const token = req.body._csrf || req.headers['x-csrf-token'];
    return Array.isArray(token) ? token[0] : token;
  },
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // Trust Cloudflare proxy

app.use(session({
  store: new SqliteStore({ client: sessionsDb, expired: { clear: true, intervalMs: 900000 } }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use(csrfSynchronisedProtection);

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function detectFlashType(flash) {
  if (!flash) return '';
  const lower = flash.toLowerCase();
  if (/failed|error|not found|missing|invalid|required/.test(lower)) return 'error';
  if (/success|booked|synced|saved|created|updated|deleted|fetched|scanned|labeled|parsed|applied|connected/.test(lower)) return 'success';
  return '';
}

// EJS layout helper - wrap all renders with layout
const originalRender = app.response.render;
app.response.render = function(view, options, callback) {
  const self = this;
  const app = self.app;
  const csrfToken = generateToken(self.req);

  // Render the view first, then wrap in layout
  app.render(view, { ...options, csrfToken }, (err, body) => {
    if (err) {
      if (callback) return callback(err);
      return self.status(500).send('Render error: ' + escapeHtml(err.message));
    }
    const flashType = detectFlashType(options?.flash);
    originalRender.call(self, 'layout', { ...options, csrfToken, body, user: self.req.session?.user, flashType }, callback);
  });
};

// Login routes (unprotected)
app.use('/login', require('./routes/login'));

// Auth wall - require login for everything below
app.use((req, res, next) => {
  if (req.session?.user) return next();
  res.redirect('/login');
});

// Protected routes
app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
app.use('/invoices', require('./routes/invoices'));
app.use('/settings', require('./routes/settings'));

// Error handler
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  const status = err.statusCode || 500;
  res.status(status).render('layout', {
    title: 'Error',
    body: `<h1>Error</h1><p>${escapeHtml(err.message)}</p>`,
    flash: null,
  });
});

// Start HTTPS if certs exist, otherwise HTTP
const certPath = path.join(__dirname, '..', 'certs', 'localhost.pem');
const keyPath = path.join(__dirname, '..', 'certs', 'localhost-key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  https.createServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  }, app).listen(config.port, '127.0.0.1', () => {
    console.log(`Bookkeeping Tools running at https://localhost:${config.port}`);

    // Auto-fetch invoices from Gmail every hour
    const gmailService = require('./services/gmail');
    setInterval(() => gmailService.autoFetch(), 60 * 60 * 1000);
  });
} else {
  console.warn('No certs found in certs/ - starting HTTP only (Exact Online OAuth will not work)');
  console.warn('Run: mkcert -install && mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost');
  app.listen(config.port, '127.0.0.1', () => {
    console.log(`Bookkeeping Tools running at http://localhost:${config.port}`);

    // Auto-fetch invoices from Gmail every hour
    const gmailService = require('./services/gmail');
    setInterval(() => gmailService.autoFetch(), 60 * 60 * 1000);
  });
}
