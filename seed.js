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
    condition TEXT NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    featured INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const sample = [
  ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'fiction', 'good', 7.5, 'available', 1],
  ['A Short History of Nearly Everything', 'Bill Bryson', 'nonfiction', 'like new', 9.0, 'available', 1],
  ['The Voyage of the Beagle', 'Charles Darwin', 'vintage', 'well-loved', 12.0, 'available', 1],
  ['Ficciones', 'Jorge Luis Borges', 'fiction', 'good', 8.0, 'available', 0],
  ['A First Edition Field Guide', 'Anonymous', 'rare', 'good', 45.0, 'available', 0]
];

const insert = db.prepare(`
  INSERT INTO books (id, title, author, category, condition, price, status, featured)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

for (const [title, author, category, condition, price, status, featured] of sample) {
  insert.run(id(), title, author, category, condition, price, status, featured);
}

console.log(`Seeded ${sample.length} books into ${DB_PATH}`);
