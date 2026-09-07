/**
 * ייבוא נתונים מקובצי CSV (שיוצאו מגוגל שיטס) לתוך מסד הנתונים SQLite
 * ============================================================================
 * שימוש:
 *   1. פתח את הגיליון הישן שלך ב-Google Sheets
 *   2. קובץ → הורדה → ערכים מופרדים בפסיקים (.csv) - פעם אחת לטאב "תורמים"
 *      ופעם אחת לטאב "מתרימים"
 *   3. שים את שני הקבצים בתיקייה הזו בשם donors.csv ו-collectors.csv
 *   4. הרץ: node import-csv.js
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = path.join(__dirname, 'trumot.db');
const db = new Database(DB_FILE);
db.exec(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else {
        current += char;
      }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ',') { result.push(current); current = ''; }
      else { current += char; }
    }
  }
  result.push(current);
  return result.map(cell => cell.trim());
}

function readCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim() !== '');
  return lines.slice(1).map(parseCsvLine);
}

function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if ((p.length === 8 || p.length === 9) && p.charAt(0) !== '0') p = '0' + p;
  return p;
}

// ----- ייבוא תורמים -----
// סדר עמודות בגיליון הישן: קוד רחוב, שם רחוב, בניין, דירה, קוד תורם, שם, סכום, ידני, סטטוס, תאריך
const donorsPath = path.join(__dirname, 'donors.csv');
if (fs.existsSync(donorsPath)) {
  const rows = readCsv(donorsPath);
  const insert = db.prepare(
    'INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name, amount, manual, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(rows => {
    rows.forEach(r => {
      insert.run(r[0], r[1], r[2], r[3], r[4], r[5], Number(r[6]) || 0, Number(r[7]) || 0, r[8] || '', r[9] || null);
    });
  });
  tx(rows);
  console.log(`יובאו ${rows.length} תורמים.`);
} else {
  console.log('לא נמצא donors.csv - דילוג.');
}

// ----- ייבוא מתרימים -----
// סדר עמודות בגיליון הישן: טלפון, שם, שם רחוב, קוד רחוב, אחראי על בניינים, יעד
const collectorsPath = path.join(__dirname, 'collectors.csv');
if (fs.existsSync(collectorsPath)) {
  const rows = readCsv(collectorsPath);
  const insert = db.prepare(
    'INSERT INTO collectors (phone, name, street_name, street_code, buildings, target) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(rows => {
    rows.forEach(r => {
      insert.run(normalizePhone(r[0]), r[1], r[2], r[3], r[4] || '', Number(r[5]) || 0);
    });
  });
  tx(rows);
  console.log(`יובאו ${rows.length} מתרימים.`);
} else {
  console.log('לא נמצא collectors.csv - דילוג.');
}

console.log('הייבוא הסתיים.');
