require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
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
    image_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const sample = [
  // title, author, category, subcategory, condition, price, status, featured
  ['Barron\'s AP Chemistry', 'Neil D. Jespersen', 'ap', null, 'Used - Good', 18.0, 'available', 1],
  ['Algebra II Coursework Workbook', 'Local HS Dept.', 'hs-coursework', null, 'Used - Like new', 20.0, 'available', 1],
  ['The Official ACT Prep Guide', 'ACT, Inc.', 'act', null, 'Used - Good', 25.0, 'available', 1],
  ['The Official SAT Study Guide', 'College Board', 'sat', null, 'Used - Fair', 20.0, 'available', 0],
  ['NNAT3 Practice Test Workbook', 'TestPrep-Online', 'nnat-cogat', null, 'Used - Like new', 22.0, 'available', 0],
  ['TJHSST Admissions Prep Packet', 'Anonymous', 'tj', null, 'Used - Good', 15.0, 'available', 0],
  ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'general', 'fiction', 'Used - Good', 7.5, 'available', 0],
  ['A Short History of Nearly Everything', 'Bill Bryson', 'general', 'nonfiction', 'Used - Like new', 9.0, 'available', 0],
  ['Charlotte\'s Web', 'E.B. White', 'general', 'kids', 'Used - Good', 5.0, 'available', 0]
];

const insert = db.prepare(`
  INSERT INTO books (id, title, author, category, subcategory, condition, price, status, featured)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

for (const [title, author, category, subcategory, condition, price, status, featured] of sample) {
  insert.run(id(), title, author, category, subcategory, condition, price, status, featured);
}

console.log(`Seeded ${sample.length} books into ${DB_PATH}`);
