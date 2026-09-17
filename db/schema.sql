-- מערכת ניהול תרומות - סכימת מסד נתונים (גרסה 2)
-- =========================================

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  street_code TEXT NOT NULL,
  street_name TEXT NOT NULL,
  building TEXT NOT NULL,
  apartment TEXT NOT NULL,
  donor_code TEXT NOT NULL,   -- מתחדש מ-1 בכל בניין בנפרד
  name TEXT NOT NULL,
  amount REAL DEFAULT 0,
  manual REAL DEFAULT 0,
  status TEXT DEFAULT '',
  updated_at TEXT,
  under_20 INTEGER DEFAULT 0,  -- דגל: תרם פחות מ-20 ש"ח (עצמאי מהסטטוס והסכום)
  system_id TEXT DEFAULT ''  -- מזהה קבוע של התורם מעמודה L בגיליון
);

CREATE INDEX IF NOT EXISTS idx_donors_street ON donors(street_code);
CREATE INDEX IF NOT EXISTS idx_donors_code ON donors(donor_code);
CREATE INDEX IF NOT EXISTS idx_donors_apt ON donors(apartment);

CREATE TABLE IF NOT EXISTS collectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  street_code TEXT NOT NULL,
  street_name TEXT,
  buildings TEXT DEFAULT '',   -- מספרי בניין מופרדים בנקודה-פסיק (;) או פסיק, ריק = כל הבניינים ברחוב
  target REAL DEFAULT 0,
  note_before TEXT DEFAULT '',   -- תשובה לפני הגבייה
  note_after TEXT DEFAULT '',    -- תשובה אחרי הגבייה
  collector_status TEXT DEFAULT '',  -- סיווג סטטוס של המתרים עצמו (למשל "פעיל", "לא פנה אליו")
  updater_phone TEXT DEFAULT '',  -- נייד של מי שמעדכן את התרומות עבור מתרים שלא נוח לו לעדכן בעצמו
  collector_code TEXT DEFAULT ''  -- "מזהה1" מהגיליון - קוד/מזהה פנימי של המתרים
);

CREATE INDEX IF NOT EXISTS idx_collectors_phone ON collectors(phone);

-- ארכיון מגביות: כל שורה היא "תמונת מצב" של תורם ברגע סגירת מגבית.
-- close_at הוא תאריך אמיתי (לא טקסט בכותרת כמו בגיליון) - קל לסנן לפי חודש.
CREATE TABLE IF NOT EXISTS campaign_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donor_id INTEGER NOT NULL,
  amount REAL DEFAULT 0,
  manual REAL DEFAULT 0,
  status TEXT DEFAULT '',
  updated_at TEXT,
  closed_at TEXT NOT NULL,
  period_name TEXT DEFAULT '',  -- שם המגבית שנסגרה (למשל "ראש השנה", "יום כיפור", "סוכות")
  FOREIGN KEY(donor_id) REFERENCES donors(id)
);

CREATE INDEX IF NOT EXISTS idx_archive_closed_at ON campaign_archive(closed_at);
CREATE INDEX IF NOT EXISTS idx_archive_donor ON campaign_archive(donor_id);
CREATE INDEX IF NOT EXISTS idx_archive_period ON campaign_archive(period_name);

-- טבלת הגדרות כלליות - כרגע משמשת רק לזכור מהי המגבית הפעילה כעת
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
