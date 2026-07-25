require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const { appendRow } = require('./sheets');

// ---------- Required env vars (fail loudly instead of running insecurely) ----------
const REQUIRED_ENV = ['JWT_SECRET', 'ADMIN_PASSWORD_HASH'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. See .env.example.`);
    process.exit(1);
  }
}

const {
  JWT_SECRET,
  ADMIN_PASSWORD_HASH,
  PORT = 3000,
  DB_PATH = path.join(__dirname, 'data.db'),
  FRONTEND_ORIGIN = '', // e.g. https://reshelved.netlify.app - comma-separated if multiple
  NODE_ENV = 'development'
} = process.env;

const allowedOrigins = FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);

// ---------- DB ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT,
    condition TEXT NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sell_leads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    edition TEXT,
    year_bought TEXT,
    condition TEXT NOT NULL,
    isbn TEXT,
    notes TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS buy_orders (
    id TEXT PRIMARY KEY,
    title TEXT,
    isbn TEXT,
    author TEXT,
    needed_by TEXT,
    notes TEXT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    grade TEXT NOT NULL,
    high_school TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    book_ids TEXT NOT NULL,
    book_summary TEXT NOT NULL,
    total REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration guard: the two CREATE TABLE statements above only apply to brand-new
// databases. An already-deployed DB (Railway volume) keeps its existing schema,
// so add any columns introduced after the first deploy by hand. isbn stays
// nullable at the DB level even though the API now requires it - SQLite can't
// add a NOT NULL column without a default to a table that may already have rows,
// so "required" is enforced in the /api/sell handler instead.
function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
ensureColumn('books', 'subcategory', 'TEXT');
ensureColumn('sell_leads', 'edition', 'TEXT');
ensureColumn('sell_leads', 'year_bought', 'TEXT');
ensureColumn('sell_leads', 'phone', 'TEXT');

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed for correct rate-limit IPs

app.use(express.json({ limit: '100kb' }));

app.use(cors({
  origin(origin, cb) {
    // Allow same-origin/non-browser requests (no Origin header) and configured origins.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  }
}));

// No cookies are used for auth, so no `credentials: true` is needed on CORS -
// this sidesteps the SameSite cross-origin cookie problem entirely.

// ---------- Validation helpers ----------
const CATEGORIES = ['ap', 'hs-coursework', 'act', 'sat', 'nnat-cogat', 'tj', 'general'];
const GENERAL_SUBCATEGORIES = ['fiction', 'nonfiction', 'kids'];
const CONDITIONS = ['New', 'Used - Like new', 'Used - Good', 'Used - Fair'];
const GRADES = ['K', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', 'Other'];

function isNonEmptyString(v, maxLen = 500) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

// Loose on purpose - just enough to catch "abc" or a stray sentence, not to
// enforce a specific country's phone format.
function isPlausiblePhone(v) {
  if (typeof v !== 'string') return false;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

// Structural check only (length + digit shape) - not a full ISBN-10/13 checksum,
// which would reject real ISBNs on any typo in a way that's hard to recover from.
function isValidIsbn(v) {
  if (typeof v !== 'string') return false;
  const cleaned = v.replace(/[-\s]/g, '');
  return /^\d{9}[\dXx]$/.test(cleaned) || /^\d{13}$/.test(cleaned);
}

// ---------- Auth ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.' }
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { passcode } = req.body || {};
  if (!isNonEmptyString(passcode, 200)) {
    return res.status(400).json({ error: 'Passcode required.' });
  }
  const ok = await bcrypt.compare(passcode, ADMIN_PASSWORD_HASH);
  if (!ok) {
    return res.status(401).json({ error: 'Wrong passcode.' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing admin token.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') throw new Error('bad role');
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// Public form submissions (Sell, Buy Order) get a looser limiter than admin login -
// generous enough for a real visitor, tight enough to blunt scripted spam.
const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this connection. Try again later.' }
});

// ---------- Public book endpoints ----------
app.get('/api/books', (req, res) => {
  const { featured } = req.query;
  let rows;
  if (featured === 'true') {
    rows = db.prepare(`SELECT * FROM books WHERE status = 'available' AND featured = 1 ORDER BY created_at DESC`).all();
  } else {
    rows = db.prepare(`SELECT * FROM books WHERE status = 'available' ORDER BY created_at DESC`).all();
  }
  res.json(rows);
});

// ---------- Sell leads (public submit) ----------
app.post('/api/sell', formLimiter, (req, res) => {
  const { title, author, edition, yearBought, condition, isbn, notes, email, phone } = req.body || {};

  if (!isNonEmptyString(title) || !isNonEmptyString(author) || !isNonEmptyString(email, 320)) {
    return res.status(400).json({ error: 'Title, author, and email are required.' });
  }
  if (!CONDITIONS.includes(condition)) {
    return res.status(400).json({ error: 'Invalid condition.' });
  }
  // Simple email shape check - not exhaustive, just catches obvious junk.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email.' });
  }
  if (!isPlausiblePhone(phone)) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }
  if (!isNonEmptyString(isbn, 32) || !isValidIsbn(isbn)) {
    return res.status(400).json({ error: 'A valid 10- or 13-digit ISBN is required.' });
  }
  if (edition && (typeof edition !== 'string' || edition.length > 100)) {
    return res.status(400).json({ error: 'Edition is too long.' });
  }
  let yearBoughtValue = null;
  if (yearBought !== undefined && yearBought !== null && yearBought !== '') {
    const yearNum = Number(yearBought);
    const currentYear = new Date().getFullYear();
    if (!Number.isInteger(yearNum) || yearNum < 1990 || yearNum > currentYear + 1) {
      return res.status(400).json({ error: 'Year bought looks invalid.' });
    }
    yearBoughtValue = String(yearNum);
  }
  if (notes && (typeof notes !== 'string' || notes.length > 2000)) {
    return res.status(400).json({ error: 'Notes too long.' });
  }

  const id = newId();
  db.prepare(`
    INSERT INTO sell_leads (id, title, author, edition, year_bought, condition, isbn, notes, email, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title.trim(),
    author.trim(),
    edition ? edition.trim() : null,
    yearBoughtValue,
    condition,
    isbn.trim(),
    notes ? notes.trim() : null,
    email.trim(),
    phone.trim()
  );

  appendRow('Sell Leads', [
    new Date().toISOString(),
    title.trim(),
    author.trim(),
    edition ? edition.trim() : '',
    yearBoughtValue || '',
    condition,
    isbn.trim(),
    notes ? notes.trim() : '',
    email.trim(),
    phone.trim()
  ]);

  res.status(201).json({ ok: true });
});

// ---------- Buy orders (public submit - "can't find it, please source it") ----------
app.post('/api/buy-order', formLimiter, (req, res) => {
  const {
    title, isbn, author, neededBy, notes,
    fullName, email, phone, grade, highSchool
  } = req.body || {};

  const hasTitle = isNonEmptyString(title, 300);
  const hasIsbn = isNonEmptyString(isbn, 32);
  if (!hasTitle && !hasIsbn) {
    return res.status(400).json({ error: 'Enter a book title or an ISBN so we know what to look for.' });
  }
  if (!isNonEmptyString(author, 200)) {
    return res.status(400).json({ error: 'Author is required.' });
  }
  if (!isNonEmptyString(fullName, 200)) {
    return res.status(400).json({ error: 'Full name is required.' });
  }
  if (!isNonEmptyString(email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!isPlausiblePhone(phone)) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }
  if (!GRADES.includes(grade)) {
    return res.status(400).json({ error: 'Please select the grade being entered.' });
  }
  if (!isNonEmptyString(highSchool, 200)) {
    return res.status(400).json({ error: 'School is required.' });
  }
  if (neededBy && (typeof neededBy !== 'string' || neededBy.length > 100)) {
    return res.status(400).json({ error: 'Needed-by is too long.' });
  }
  if (notes && (typeof notes !== 'string' || notes.length > 2000)) {
    return res.status(400).json({ error: 'Notes too long.' });
  }

  const id = newId();
  db.prepare(`
    INSERT INTO buy_orders (id, title, isbn, author, needed_by, notes, full_name, email, phone, grade, high_school)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    hasTitle ? title.trim() : null,
    hasIsbn ? isbn.trim() : null,
    author.trim(),
    neededBy ? neededBy.trim() : null,
    notes ? notes.trim() : null,
    fullName.trim(),
    email.trim(),
    phone.trim(),
    grade,
    highSchool.trim()
  );

  appendRow('Buy Orders', [
    new Date().toISOString(),
    hasTitle ? title.trim() : '',
    hasIsbn ? isbn.trim() : '',
    author.trim(),
    neededBy ? neededBy.trim() : '',
    notes ? notes.trim() : '',
    fullName.trim(),
    email.trim(),
    phone.trim(),
    grade,
    highSchool.trim()
  ]);

  res.status(201).json({ ok: true });
});

// ---------- Reservations (public checkout - "reserve & hold" from the cart) ----------
app.post('/api/reserve', formLimiter, (req, res) => {
  const { bookIds, fullName, email, phone } = req.body || {};

  if (!Array.isArray(bookIds) || bookIds.length === 0 || bookIds.length > 50 || !bookIds.every(id => typeof id === 'string' && id.length <= 64)) {
    return res.status(400).json({ error: 'No books selected to reserve.' });
  }
  if (!isNonEmptyString(fullName, 200)) {
    return res.status(400).json({ error: 'Full name is required.' });
  }
  if (!isNonEmptyString(email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!isPlausiblePhone(phone)) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }

  // Dedupe defensively - a repeated id in the payload would otherwise double-reserve/double-count.
  const uniqueIds = [...new Set(bookIds)];

  // Everything below happens in one transaction so two people checking out the
  // same copy at the same moment can't both "win" it.
  const reserveTx = db.transaction((ids) => {
    const reserved = [];
    const unavailable = [];
    for (const id of ids) {
      const book = db.prepare(`SELECT * FROM books WHERE id = ?`).get(id);
      if (!book || book.status !== 'available') {
        unavailable.push(id);
        continue;
      }
      const result = db.prepare(`UPDATE books SET status = 'reserved' WHERE id = ? AND status = 'available'`).run(id);
      if (result.changes === 1) {
        reserved.push(book);
      } else {
        unavailable.push(id); // lost a race with another checkout between the SELECT and UPDATE
      }
    }
    return { reserved, unavailable };
  });

  const { reserved, unavailable } = reserveTx(uniqueIds);

  if (reserved.length === 0) {
    return res.status(409).json({ error: 'Sorry, those were just reserved by someone else. Refresh the page and try again.' });
  }

  const total = reserved.reduce((sum, b) => sum + Number(b.price), 0);
  const summary = reserved.map(b => ({ title: b.title, author: b.author, condition: b.condition, price: b.price }));

  const id = newId();
  db.prepare(`
    INSERT INTO reservations (id, full_name, email, phone, book_ids, book_summary, total)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, fullName.trim(), email.trim(), phone.trim(), JSON.stringify(reserved.map(b => b.id)), JSON.stringify(summary), total);

  reserved.forEach(book => {
    appendRow('Reserved', [
      new Date().toISOString(),
      book.title,
      book.author,
      book.condition,
      Number(book.price).toFixed(2),
      fullName.trim(),
      email.trim(),
      phone.trim()
    ]);
  });

  res.status(201).json({
    ok: true,
    reservedCount: reserved.length,
    unavailable,
    total
  });
});

// ---------- Admin: inventory ----------
app.get('/api/admin/books', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM books ORDER BY created_at DESC`).all();
  res.json(rows);
});

app.post('/api/admin/books', requireAdmin, (req, res) => {
  const { title, author, category, subcategory, condition, price, status = 'available', featured = false } = req.body || {};

  if (!isNonEmptyString(title) || !isNonEmptyString(author)) {
    return res.status(400).json({ error: 'Title and author are required.' });
  }
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Invalid category.' });
  let subcategoryValue = null;
  if (category === 'general') {
    if (!GENERAL_SUBCATEGORIES.includes(subcategory)) {
      return res.status(400).json({ error: 'General books need a subcategory (Fiction, Nonfiction, or Kids).' });
    }
    subcategoryValue = subcategory;
  }
  if (!CONDITIONS.includes(condition)) return res.status(400).json({ error: 'Invalid condition.' });
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Invalid price.' });
  }
  if (!['available', 'sold'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  const id = newId();
  db.prepare(`
    INSERT INTO books (id, title, author, category, subcategory, condition, price, status, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title.trim(), author.trim(), category, subcategoryValue, condition, price, status, featured ? 1 : 0);

  res.status(201).json(db.prepare('SELECT * FROM books WHERE id = ?').get(id));
});

app.patch('/api/admin/books/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found.' });

  const { status } = req.body || {};
  if (!['available', 'sold', 'reserved'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });

  db.prepare('UPDATE books SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id));
});

app.delete('/api/admin/books/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM books WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

// ---------- Admin: sell leads ----------
app.get('/api/admin/leads', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM sell_leads ORDER BY created_at DESC`).all();
  res.json(rows);
});

// ---------- Admin: buy orders ----------
app.get('/api/admin/buy-orders', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT * FROM buy_orders ORDER BY created_at DESC`).all();
  res.json(rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, () => {
  console.log(`reshelved backend listening on :${PORT} (${NODE_ENV})`);
});
