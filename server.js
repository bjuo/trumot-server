/**
 * מערכת ניהול תרומות - שרת ייעודי (Node.js + SQLite)
 * ============================================================================
 * מחליף את שרשרת Google Sheets + Apps Script + Cloudflare Worker.
 * אותה בדיוק לוגיקת תפריטים, ניסוחים ומקשים לימות כמו בגרסת Apps Script -
 * רק שכבת הנתונים שונה (SQLite מקומי במקום Google Sheets).
 *
 * טאב "טלפנים" בגיליון (עם כל השדות הידניים שלך) ממשיך להתקיים כרגיל -
 * ראה sheetsSync.js לפרטים על איך העמודות K-P שם מתעדכנות אוטומטית.
 * ============================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'trumot.db');
const ADMIN_PIN = process.env.ADMIN_PIN || '2468'; // שנה בהגדרות הסביבה (Environment Variables) בשרת שלך!
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 שעות

const STATUS_TEXT = { '2': 'לא פתחו', '3': 'ביקשו לבוא פעם אחרת', '4': 'פתחו ולא תרמו' };
const LISTING_CHUNK_SIZE = 4;

// ============================================================================
// אתחול מסד הנתונים
// ============================================================================
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));

// מיגרציה בטוחה: מוסיפים עמודות חדשות לטבלה קיימת אם עוד לא קיימות
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[migration] נוספה עמודה ${column} לטבלת ${table}`);
  }
}
ensureColumn('collectors', 'note_before', "TEXT DEFAULT ''");
ensureColumn('collectors', 'note_after', "TEXT DEFAULT ''");
ensureColumn('collectors', 'collector_status', "TEXT DEFAULT ''");
ensureColumn('collectors', 'updater_phone', "TEXT DEFAULT ''");
ensureColumn('donors', 'under_20', "INTEGER DEFAULT 0");
ensureColumn('collectors', 'collector_code', "TEXT DEFAULT ''");
ensureColumn('donors', 'system_id', "TEXT DEFAULT ''");
ensureColumn('collectors', 'note_before_yomkipur', "TEXT DEFAULT ''");
ensureColumn('collectors', 'note_after_yomkipur', "TEXT DEFAULT ''");
ensureColumn('collectors', 'collector_status_yomkipur', "TEXT DEFAULT ''");
ensureColumn('campaign_archive', 'period_name', "TEXT DEFAULT ''");

// ============================================================================
// ניהול "מגבית פעילה" - ראש השנה / יום כיפור / סוכות
// ============================================================================
const PERIODS = ['ראש השנה', 'יום כיפור', 'סוכות'];

function getSetting(key, defaultValue) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function getCurrentPeriod() {
  return getSetting('current_period', PERIODS[0]);
}

// ============================================================================
// מצבי שיחה - זיכרון פשוט (שרת רץ ברציפות, אין צורך ב-CacheService)
// ============================================================================
const callSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of callSessions) {
    if (now - s.createdAt > SESSION_TTL_MS) callSessions.delete(id);
  }
}, 10 * 60 * 1000);

function isEmptyAnswer(v) {
  return v === undefined || v === null || v === '' || v === 'None';
}

// ============================================================================
// קצה API עבור ימות המשיח
// ============================================================================
app.get('/yemot', (req, res) => {
  res.set('Content-Type', 'text/plain; charset=utf-8');
  try {
    return handleYemotRequest(req, res);
  } catch (err) {
    console.error(err);
    return res.send('id_list_message=t-אירעה שגיאה זמנית במערכת, אנא נסו שוב מאוחר יותר');
  }
});

function handleYemotRequest(req, res) {
  const p = req.query;
  const callId = p.ApiCallId || 'no_session';

  if (p.hangup === 'yes') {
    return res.send('noop');
  }

  let state = callSessions.get(callId);

  if (!state) {
    const phone = normalizePhone(p.ApiPhone || '');
    const collector = findCollector(phone);
    if (!collector) {
      return res.send('id_list_message=t-מספר הטלפון שממנו התקשרתם אינו מזוהה כמתרים במערכת');
    }
    state = {
      createdAt: Date.now(), step: 'menu', pc: 0,
      assignments: collector.assignments,
      collectorName: collector.name,
      target: collector.target,
    };
    callSessions.set(callId, state);
    return res.send(mainMenuRead(state));
  }

  const answer = state.expectKey ? p[state.expectKey] : undefined;
  let result;

  switch (state.step) {
    case 'menu': result = handleMenuChoice(answer, state); break;
    case 'sub4_menu': result = handleSub4Menu(answer, state); break;
    case 'sub4_pick_building': result = handleSub4PickBuilding(answer, state); break;
    case 'sub4_listing': result = handleSub4Listing(answer, state); break;
    case 'seq_pick_building': result = handleSeqPickBuilding(answer, state); break;
    case 'seq_action': result = handleSeqAction(answer, state); break;
    case 'seq_amount': result = handleSeqAmount(answer, state); break;
    case 'bycode_number': result = handleBycodeNumber(answer, state); break;
    case 'bycode_pick_building': result = handleBycodePickBuilding(answer, state); break;
    case 'bycode_confirm': result = handleBycodeConfirm(answer, state); break;
    case 'info_action': result = handleInfoAction(answer, state); break;
    case 'bycode_action': result = handleBycodeAction(answer, state); break;
    case 'bycode_amount': result = handleBycodeAmount(answer, state); break;
    case 'batch_number': result = handleBatchNumber(answer, state); break;
    case 'batch_confirm': result = handleBatchConfirm(answer, state); break;
    case 'batch_status': result = handleBatchStatus(answer, state); break;
    default:
      state.step = 'menu';
      result = mainMenuRead(state);
  }

  callSessions.set(callId, state);
  return res.send(result);
}

// ============================================================================
// תפריט ראשי
// ============================================================================
function mainMenuRead(state) {
  const msg =
    't-ברוכים הבאים, ' +
    'לשמיעת רשימת תורמים לפי סדר דירות הקישו 1, ' +
    'לעדכון לפי קוד תורם הקישו 2, ' +
    'לעדכון קבוצתי של מספר דירות הקישו 3, ' +
    'לשמיעת תורמים שטרם הושלמו הקישו 4, ' +
    'לשמיעת מה מעודכן על קוד תורם הקישו 5, ' +
    'לאזור האישי שלך הקישו 6';
  return readBuild(msg, 'Sel', { max: 1, min: 1, say: 'NO' }, state);
}

function handleMenuChoice(sel, state) {
  const assignments = state.assignments;

  if (sel === '1') {
    const buildings = getDistinctBuildingsForAssignments(assignments);
    if (buildings.length > 1) {
      state.step = 'seq_pick_building';
      state.seqBuildings = buildings;
      const list = buildings.map(b => `רחוב ${escTts(b.streetName)} בניין ${b.building}`).join(', ');
      const msg = `t-אתה אחראי על בניינים, ${list}, הקישו את מספר הבניין שברצונך לשמוע, או כוכבית לתפריט הראשי`;
      return readBuild(msg, 'SeqBuilding', { max: 4, min: 1, say: 'Number' }, state);
    }
    return startSeqList(assignments, state);
  }

  if (sel === '2') {
    state.step = 'bycode_number';
    state.purpose = 'update';
    return askDonorCode(state);
  }

  if (sel === '3') {
    state.step = 'batch_number';
    state.batchList = [];
    return readBuild('t-הקישו מספר דירה ראשון וסולמית, סולמית ריקה לסיום ההזנה, או כוכבית לתפריט הראשי', 'BatchApt', { max: 5, min: 0, say: 'Number', okOnEmpty: true }, state);
  }

  if (sel === '4') {
    state.step = 'sub4_menu';
    const msg = 't-לשמיעת כל התורמים ברצף הקישו 1, לשמיעה עם אפשרות עדכון הקישו 2, לחזרה לתפריט הראשי הקישו כוכבית';
    return readBuild(msg, 'Sub4', { max: 1, min: 1, say: 'NO' }, state);
  }

  if (sel === '5') {
    state.step = 'bycode_number';
    state.purpose = 'info';
    return askDonorCode(state);
  }

  if (sel === '6') {
    state.step = 'menu';
    return 'id_list_message=' + personalAreaSummary(state) + '&' + mainMenuRead(state);
  }

  return 'id_list_message=t-מקש לא חוקי&' + mainMenuRead(state);
}

function personalAreaSummary(state) {
  const stats = donorStatsFor(state.assignments);
  const raised = Math.round(monthlyTotalForCollector(state.assignments));
  let msg =
    `t-יש לך סך הכל` + '.' + `n-${stats.total}` + '.' + `t-תורמים, מהם` + '.' +
    `n-${stats.completed}` + '.' + `t-כבר תרמו, ו` + '.' + `n-${stats.needReturn}` + '.' +
    `t-לא פתחו או ביקשו לבוא פעם אחרת` + '.' +
    `t-גייסת` + '.' + `n-${raised}` + '.' + `t-שקלים החודש`;
  if (state.target > 0) {
    msg += '.' + `t-מתוך יעד של` + '.' + `n-${state.target}` + '.' + `t-שקלים`;
  }
  return msg;
}

function targetProgressLine(state) {
  if (!state.target || state.target <= 0) return '';
  const raised = Math.round(monthlyTotalForCollector(state.assignments));
  return `t-נכון לעכשיו גייסת` + '.' + `n-${raised}` + '.' + `t-שקלים מתוך יעד` + '.' + `n-${state.target}` + '.' + `t-שקלים לחודש זה`;
}

// ============================================================================
// אפשרות 4: תת-תפריט + הקראה מפוצלת (עם עצירות אמיתיות לכוכבית)
// ============================================================================
function handleSub4Menu(answer, state) {
  if (answer === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }

  if (answer === '1') {
    const buildings = getDistinctBuildingsForAssignments(state.assignments);
    if (buildings.length > 1) {
      state.step = 'sub4_pick_building';
      state.sub4Buildings = buildings;
      const list = buildings.map(b => `רחוב ${escTts(b.streetName)} בניין ${b.building}`).join(', ');
      const msg = `t-אתה אחראי על בניינים, ${list}, הקישו את מספר הבניין שברצונך לשמוע, או כוכבית לתפריט הראשי`;
      return readBuild(msg, 'Sub4Building', { max: 4, min: 1, say: 'Number' }, state);
    }
    return startUncompletedListing(state.assignments, state);
  }

  if (answer === '2') {
    const buildings = getDistinctBuildingsForAssignments(state.assignments);
    if (buildings.length > 1) {
      state.step = 'seq_pick_building';
      state.seqBuildings = buildings;
      const list = buildings.map(b => `רחוב ${escTts(b.streetName)} בניין ${b.building}`).join(', ');
      const msg = `t-אתה אחראי על בניינים, ${list}, הקישו את מספר הבניין שברצונך לשמוע, או כוכבית לתפריט הראשי`;
      return readBuild(msg, 'SeqBuilding', { max: 4, min: 1, say: 'Number' }, state);
    }
    return startSeqList(state.assignments, state);
  }

  const msg = 't-מקש לא חוקי, לשמיעת כל התורמים ברצף הקישו 1, לשמיעה עם אפשרות עדכון הקישו 2, לחזרה לתפריט הראשי הקישו כוכבית';
  return readBuild(msg, 'Sub4', { max: 1, min: 1, say: 'NO' }, state);
}

function handleSub4PickBuilding(building, state) {
  if (building === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  const match = state.sub4Buildings.find(b => String(b.building) === String(building));
  if (!match) {
    const list = state.sub4Buildings.map(b => `רחוב ${escTts(b.streetName)} בניין ${b.building}`).join(', ');
    const msg = `t-מספר בניין לא נמצא, ${list}, הקישו את מספר הבניין שברצונך לשמוע, או כוכבית לתפריט הראשי`;
    return readBuild(msg, 'Sub4Building', { max: 4, min: 1, say: 'Number' }, state);
  }
  const scoped = [{ streetCode: match.streetCode, building: match.building }];
  return startUncompletedListing(scoped, state);
}

function startUncompletedListing(assignments, state) {
  const incomplete = getUncompletedDonors(assignments);
  if (incomplete.length === 0) {
    const progress = targetProgressLine(state);
    state.step = 'menu';
    const msg = (progress ? progress + '.' : '') + 't-כל התורמים בבניינים שלך הושלמו';
    return 'id_list_message=' + msg + '&' + mainMenuRead(state);
  }
  state.listingItems = incomplete;
  state.listingIndex = 0;
  state.step = 'sub4_listing';
  return buildListingChunk(state);
}

function buildListingChunk(state) {
  const items = state.listingItems;
  const startIdx = state.listingIndex;
  const chunk = items.slice(startIdx, startIdx + LISTING_CHUNK_SIZE);

  const parts = chunk.map((d, idx) => {
    const globalIdx = startIdx + idx;
    if (globalIdx === 0) {
      return `t-רחוב ${escTts(d.street_name)} בניין ${d.building} קוד` + '.' + `n-${d.donor_code}` + '.' + `t-${escTts(d.name)}`;
    }
    return `t-קוד` + '.' + `n-${d.donor_code}` + '.' + `t-${escTts(d.name)}`;
  });

  let prefix = '';
  if (startIdx === 0) {
    const progress = targetProgressLine(state);
    prefix = progress ? progress + '.' : '';
  }

  const lines = prefix + parts.join('.');
  const nextIdx = startIdx + chunk.length;

  if (nextIdx >= items.length) {
    state.step = 'menu';
    return 'id_list_message=' + lines + '.' + 't-סיימת את הרשימה&' + mainMenuRead(state);
  }

  state.listingIndex = nextIdx;
  const checkpoint = readBuild('t-להמשך הקישו כל מקש, לחזרה לתפריט הראשי הקישו כוכבית', 'ListingNext', { max: 1, min: 0, say: 'NO', okOnEmpty: true }, state);
  return 'id_list_message=' + lines + '&' + checkpoint;
}

function handleSub4Listing(answer, state) {
  if (answer === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  return buildListingChunk(state);
}

function startSeqList(assignments, state) {
  const list = getSortedDonors(assignments);
  if (list.length === 0) {
    state.step = 'menu';
    return 'id_list_message=t-כל התורמים ברחובות שלך כבר הושלמו&' + mainMenuRead(state);
  }
  state.step = 'seq_action';
  state.seqList = list.map(d => d.id);
  state.seqIndex = 0;
  return announceDonorAndAsk(state.seqList[0], state);
}

function handleSeqPickBuilding(building, state) {
  if (building === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  const match = state.seqBuildings.find(b => String(b.building) === String(building));
  if (!match) {
    const list = state.seqBuildings.map(b => `רחוב ${escTts(b.streetName)} בניין ${b.building}`).join(', ');
    const msg = `t-מספר בניין לא נמצא, ${list}, הקישו את מספר הבניין שברצונך לשמוע, או כוכבית לתפריט הראשי`;
    return readBuild(msg, 'SeqBuilding', { max: 4, min: 1, say: 'Number' }, state);
  }
  const scoped = [{ streetCode: match.streetCode, building: match.building }];
  return startSeqList(scoped, state);
}

// ============================================================================
// אפשרות 1 (וגם אפשרות 4 תת-אפשרות 2): הקראה רציפה
// ============================================================================
function announceDonorAndAsk(donorId, state) {
  const d = getDonorById(donorId);
  const isFirst = state.seqIndex === 0;
  const locationPart = isFirst
    ? `t-רחוב ${escTts(d.street_name)} בניין ${d.building}, דירה` + '.' + `n-${d.apartment}` + '.'
    : `t-דירה` + '.' + `n-${d.apartment}` + '.';
  const msg =
    locationPart +
    `t-${escTts(d.name)}` + '.' +
    `t-להזנת סכום תרומה הקישו 1, לא פתחו את הדלת הקישו 2, ` +
    'ביקשו לבוא פעם אחרת הקישו 3, פתחו ולא תרמו הקישו 4, ' +
    'לדילוג לתורם הבא הקישו 5, לחזרה לתפריט הראשי הקישו 6 או כוכבית';
  return readBuild(msg, 'SeqAction', { max: 1, min: 1, say: 'NO' }, state);
}

function handleSeqAction(action, state) {
  const donorId = state.seqList[state.seqIndex];

  if (action === '*' || action === '6') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (action === '1') {
    state.step = 'seq_amount';
    return readBuild('t-הקישו את סכום התרומה בשקלים ובסיום הקישו סולמית, או כוכבית לתפריט הראשי', 'SeqAmount', { max: 6, min: 1, say: 'Price', confirmEntry: true }, state);
  }
  if (STATUS_TEXT[action]) {
    setStatus(donorId, STATUS_TEXT[action]);
    return advanceSeq(state, true);
  }
  if (action === '5') {
    return advanceSeq(state, false);
  }
  return 'id_list_message=t-מקש לא חוקי&' + announceDonorAndAsk(donorId, state);
}

function handleSeqAmount(amount, state) {
  if (amount === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  const donorId = state.seqList[state.seqIndex];
  const num = Number(amount);
  if (isEmptyAnswer(amount) || !(num > 0)) {
    const retry = readBuild('t-הקישו את סכום התרומה בשקלים ובסיום הקישו סולמית, או כוכבית לתפריט הראשי', 'SeqAmount', { max: 6, min: 1, say: 'Price', confirmEntry: true }, state);
    return 'id_list_message=t-הסכום חייב להיות גדול מאפס&' + retry;
  }
  setAmount(donorId, num);
  return advanceSeq(state, true);
}


function advanceSeq(state, wasUpdated) {
  state.seqIndex++;
  if (state.seqIndex >= state.seqList.length) {
    state.step = 'menu';
    const msg = (wasUpdated ? 't-עודכן. ' : '') + 't-סיימת את הרשימה';
    return 'id_list_message=' + msg + '&' + mainMenuRead(state);
  }
  state.step = 'seq_action';
  const next = announceDonorAndAsk(state.seqList[state.seqIndex], state);
  if (wasUpdated) return 'id_list_message=t-עודכן&' + next;
  return next;
}

// ============================================================================
// אפשרויות 2 + 5: חיפוש לפי קוד תורם
// ============================================================================
function askDonorCode(state) {
  return readBuild('t-הקישו את קוד התורם, או כוכבית לתפריט הראשי', 'Code', { max: 6, min: 1, say: 'Number' }, state);
}

function handleBycodeNumber(code, state) {
  if (code === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  const matches = findDonorsByCode(state.assignments, code);

  if (matches.length === 0) {
    return 'id_list_message=t-קוד תורם לא נמצא ברחובות שלך&' + askDonorCode(state);
  }

  if (matches.length === 1) {
    state.bycodeId = matches[0].id;
    state.step = 'bycode_confirm';
    return bycodeConfirmRead(state);
  }

  state.bycodePendingMatches = matches.map(m => ({ id: m.id, building: m.building }));
  const options = matches.map(m => `בניין ${m.building}`).join(', ');
  state.step = 'bycode_pick_building';
  const msg = `t-נמצא קוד זה בכמה בניינים, ${escTts(options)}, הקישו את מספר הבניין המבוקש, או כוכבית לתפריט הראשי`;
  return readBuild(msg, 'PickBuilding', { max: 4, min: 1, say: 'Number' }, state);
}

function handleBycodePickBuilding(building, state) {
  if (building === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  const match = state.bycodePendingMatches.find(m => String(m.building) === String(building));
  if (!match) {
    const options = state.bycodePendingMatches.map(m => `בניין ${m.building}`).join(', ');
    const msg = `t-מספר בניין לא נמצא, ${escTts(options)}, הקישו את מספר הבניין המבוקש, או כוכבית לתפריט הראשי`;
    return readBuild(msg, 'PickBuilding', { max: 4, min: 1, say: 'Number' }, state);
  }
  state.bycodeId = match.id;
  state.step = 'bycode_confirm';
  return bycodeConfirmRead(state);
}

function bycodeConfirmRead(state) {
  const d = getDonorById(state.bycodeId);
  const msg = `t-${escTts(d.name)}` + '.' + 't-אם זו המשפחה הנכונה הקישו 1, אם לא הקישו 2 להקשת קוד אחר, לחזרה לתפריט הראשי הקישו כוכבית';
  return readBuild(msg, 'Confirm', { max: 1, min: 1, say: 'NO' }, state);
}

function handleBycodeConfirm(answer, state) {
  if (answer === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (answer === '2') {
    state.step = 'bycode_number';
    return askDonorCode(state);
  }
  if (answer !== '1') {
    return 'id_list_message=t-מקש לא חוקי&' + bycodeConfirmRead(state);
  }

  const d = getDonorById(state.bycodeId);

  if (state.purpose === 'info') {
    const amount = (d.amount || 0) + (d.manual || 0);
    const status = d.status || 'טרם עודכן סטטוס';
    state.step = 'info_action';
    const msg =
      `t-סכום רשום` + '.' + `n-${amount}` + '.' +
      `t-סטטוס ${escTts(status)}` + '.' +
      `t-לעדכון הקישו 1, להקשת קוד תורם אחר הקישו 2, לחזרה לתפריט הראשי הקישו כוכבית`;
    return readBuild(msg, 'InfoAction', { max: 1, min: 1, say: 'NO' }, state);
  }

  if (hasAmountSet(d)) {
    const amount = (d.amount || 0) + (d.manual || 0);
    state.step = 'bycode_amount';
    const msg =
      `t-תורם זה כבר מעודכן, תרם סך` + '.' + `n-${amount}` + '.' +
      `t-שקלים, אם ברצונך לשנות הקישו סכום חדש, ובסיום הקישו סולמית, או כוכבית לתפריט הראשי`;
    return readBuild(msg, 'Amount', { max: 6, min: 1, say: 'Price', confirmEntry: true }, state);
  }

  state.step = 'bycode_action';
  return bycodeActionMenu(state);
}

function handleInfoAction(answer, state) {
  if (answer === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (answer === '2') {
    state.step = 'bycode_number';
    return askDonorCode(state);
  }
  if (answer === '1') {
    state.step = 'bycode_action';
    return bycodeActionMenu(state);
  }
  const d = getDonorById(state.bycodeId);
  const amount = (d.amount || 0) + (d.manual || 0);
  const status = d.status || 'טרם עודכן סטטוס';
  const msg = `t-מקש לא חוקי` + '.' + `t-סכום רשום` + '.' + `n-${amount}` + '.' + `t-סטטוס ${escTts(status)}` + '.' + `t-לעדכון הקישו 1, להקשת קוד תורם אחר הקישו 2, לחזרה לתפריט הראשי הקישו כוכבית`;
  return readBuild(msg, 'InfoAction', { max: 1, min: 1, say: 'NO' }, state);
}

function bycodeActionMenu(state) {
  const msg =
    't-להזנת סכום תרומה הקישו 1, לא פתחו את הדלת הקישו 2, ' +
    'ביקשו לבוא פעם אחרת הקישו 3, פתחו ולא תרמו הקישו 4, לחזרה לתפריט הראשי הקישו 5 או כוכבית';
  return readBuild(msg, 'Action', { max: 1, min: 1, say: 'NO' }, state);
}

function handleBycodeAction(action, state) {
  const donorId = state.bycodeId;
  if (action === '*' || action === '5') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (action === '1') {
    state.step = 'bycode_amount';
    return readBuild('t-הקישו את סכום התרומה בשקלים ובסיום הקישו סולמית, או כוכבית לתפריט הראשי', 'Amount', { max: 6, min: 1, say: 'Price', confirmEntry: true }, state);
  }
  if (STATUS_TEXT[action]) {
    setStatus(donorId, STATUS_TEXT[action]);
    state.step = 'bycode_number';
    return 'id_list_message=t-עודכן בהצלחה&' + askDonorCode(state);
  }
  return 'id_list_message=t-הסכום חייב להיות גדול מאפס&' + bycodeActionMenu(state);
}

function handleBycodeAmount(amount, state) {
  if (amount === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  const num = Number(amount);
  if (isEmptyAnswer(amount) || !(num > 0)) {
    const retry = readBuild('t-הקישו את סכום התרומה בשקלים ובסיום הקישו סולמית, או כוכבית לתפריט הראשי', 'Amount', { max: 6, min: 1, say: 'Price', confirmEntry: true }, state);
    return 'id_list_message=t-הסכום חייב להיות גדול מאפס&' + retry;
  }
  setAmount(state.bycodeId, num);
  state.step = 'bycode_number';
  return 'id_list_message=t-עודכן בהצלחה&' + askDonorCode(state);
}

// ============================================================================
// אפשרות 3: עדכון קבוצתי
// ============================================================================
function handleBatchNumber(apt, state) {
  if (apt === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (isEmptyAnswer(apt)) {
    if (state.batchList.length === 0) {
      state.step = 'menu';
      return 'id_list_message=t-לא הוזנו דירות&' + mainMenuRead(state);
    }
    state.step = 'batch_confirm';
    const readout = state.batchList.map(n => `n-${n}`).join('.');
    return readBuild(`t-הוזנו הדירות הבאות` + '.' + readout + '.' + `t-לאישור הקישו 1, להתחלה מחדש הקישו 2, לחזרה לתפריט הראשי הקישו כוכבית`, 'BatchConfirm', { max: 1, min: 1, say: 'NO' }, state);
  }
  state.batchList.push(apt);
  return readBuild('t-הקישו מספר דירה נוסף וסולמית, סולמית ריקה לסיום, או כוכבית לתפריט הראשי', 'BatchApt', { max: 5, min: 0, say: 'Number', okOnEmpty: true }, state);
}

function handleBatchConfirm(choice, state) {
  if (choice === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (choice === '2') {
    state.step = 'batch_number';
    state.batchList = [];
    return readBuild('t-הקישו מספר דירה ראשון וסולמית, סולמית ריקה לסיום ההזנה, או כוכבית לתפריט הראשי', 'BatchApt', { max: 5, min: 0, say: 'Number', okOnEmpty: true }, state);
  }
  if (choice === '1') {
    state.step = 'batch_status';
    return batchStatusMenu(state);
  }
  return 'id_list_message=t-מקש לא חוקי&' + readBuild('t-לאישור הקישו 1, להתחלה מחדש הקישו 2, לחזרה לתפריט הראשי הקישו כוכבית', 'BatchConfirm', { max: 1, min: 1, say: 'NO' }, state);
}

function batchStatusMenu(state) {
  const msg = 't-לסימון לא פתחו את הדלת לכולם הקישו 1, לסימון ביקשו לבוא פעם אחרת לכולם הקישו 2, לסימון פתחו ולא תרמו לכולם הקישו 3, לסימון שתרמו פחות מעשרים שקלים לכולם הקישו 4, לחזרה לתפריט הראשי הקישו כוכבית';
  return readBuild(msg, 'BatchStatus', { max: 1, min: 1, say: 'NO' }, state);
}

function handleBatchStatus(choice, state) {
  if (choice === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
  }
  if (choice === '4') {
    let updated = 0;
    state.batchList.forEach(apt => {
      const matches = findDonorsByApt(state.assignments, apt);
      matches.forEach(m => { setUnder20(m.id, true); updated++; });
    });
    state.step = 'menu';
    state.batchList = [];
    return `id_list_message=t-סומנו ${updated} דירות כתרמו פחות מעשרים שקלים&` + mainMenuRead(state);
  }
  const statusText = choice === '1' ? 'לא פתחו' : choice === '2' ? 'ביקשו לבוא פעם אחרת' : choice === '3' ? 'פתחו ולא תרמו' : null;
  if (!statusText) {
    return 'id_list_message=t-מקש לא חוקי&' + batchStatusMenu(state);
  }
  let updated = 0;
  state.batchList.forEach(apt => {
    const matches = findDonorsByApt(state.assignments, apt);
    matches.forEach(m => { setStatus(m.id, statusText); updated++; });
  });
  state.step = 'menu';
  state.batchList = [];
  return `id_list_message=t-עודכנו ${updated} דירות&` + mainMenuRead(state);
}

// ============================================================================
// גישה למסד נתונים
// ============================================================================
function normalizePhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if ((p.length === 8 || p.length === 9) && p.charAt(0) !== '0') p = '0' + p;
  return p;
}

function collectorsByPhone() {
  const rows = db.prepare('SELECT * FROM collectors').all();
  const byPhone = {};
  rows.forEach(r => {
    const phone = normalizePhone(r.phone);
    if (!byPhone[phone]) byPhone[phone] = { name: r.name, assignments: [], target: 0 };
    const streetCode = String(r.street_code || '').trim();
    const buildingsRaw = String(r.buildings || '').trim();
    const buildings = buildingsRaw.split(/[,;]/).map(b => b.trim()).filter(Boolean);
    if (streetCode) {
      if (buildings.length === 0) byPhone[phone].assignments.push({ streetCode, building: null });
      else buildings.forEach(b => byPhone[phone].assignments.push({ streetCode, building: b }));
    }
    if (r.target > 0) byPhone[phone].target = r.target;
  });
  return byPhone;
}

function findCollector(phone) {
  return collectorsByPhone()[phone] || null;
}

function matchesAssignment(assignments, streetCode, building) {
  return assignments.some(a => a.streetCode === streetCode && (a.building === null || String(a.building) === String(building)));
}

function getAllDonors() {
  return db.prepare('SELECT * FROM donors').all();
}

function getDonorById(id) {
  return db.prepare('SELECT * FROM donors WHERE id = ?').get(id);
}

function hasAmountSet(d) {
  return (d.amount && d.amount > 0) || (d.manual && d.manual > 0);
}

function getSortedDonors(assignments) {
  const donors = getAllDonors().filter(d => matchesAssignment(assignments, String(d.street_code), d.building) && !hasAmountSet(d));
  donors.sort((a, b) => Number(a.building) - Number(b.building) || Number(a.apartment) - Number(b.apartment));
  return donors;
}

function getUncompletedDonors(assignments) {
  const donors = getAllDonors().filter(d =>
    matchesAssignment(assignments, String(d.street_code), d.building) &&
    d.status !== 'פתחו ולא תרמו' &&
    !hasAmountSet(d)
  );
  donors.sort((a, b) => Number(a.building) - Number(b.building) || Number(a.apartment) - Number(b.apartment));
  return donors;
}

function findDonorsByApt(assignments, apt) {
  return getAllDonors().filter(d => matchesAssignment(assignments, String(d.street_code), d.building) && String(d.apartment) === String(apt));
}

function findDonorsByCode(assignments, code) {
  return getAllDonors().filter(d => matchesAssignment(assignments, String(d.street_code), d.building) && String(d.donor_code) === String(code));
}

function getDistinctBuildingsForAssignments(assignments) {
  const seen = {};
  const result = [];
  getAllDonors().forEach(d => {
    const streetCode = String(d.street_code);
    if (!matchesAssignment(assignments, streetCode, d.building)) return;
    const key = streetCode + '|' + d.building;
    if (!seen[key]) {
      seen[key] = true;
      result.push({ streetCode, streetName: d.street_name, building: d.building });
    }
  });
  return result;
}

function donorStatsFor(assignments, allDonors) {
  let total = 0, completed = 0, notOpened = 0, askedReturn = 0, doneNoReturn = 0, notHandled = 0;
  (allDonors || getAllDonors()).forEach(d => {
    if (!matchesAssignment(assignments, String(d.street_code), d.building)) return;
    total++;
    if (hasAmountSet(d)) completed++;
    else if (d.status === 'לא פתחו') notOpened++;
    else if (d.status === 'ביקשו לבוא פעם אחרת') askedReturn++;
    else if (d.status === 'פתחו ולא תרמו') doneNoReturn++;
    else notHandled++; // אין סכום ואין סטטוס בכלל - לא טופל עדיין
  });
  const needReturn = notOpened + askedReturn;
  return { total, completed, needReturn, notOpened, askedReturn, doneNoReturn, notHandled };
}


function monthlyTotalForCollector(assignments, allDonors, archiveMap) {
  // מחשב לפי סכימת כל המגביות (ר"ה+יו"כ+סוכות) - לא לפי חודש קלנדרי.
  // השם נשאר כמו שהיה כדי לא לשבור קריאות קיימות, אבל הלוגיקה עודכנה.
  const donors = (allDonors || getAllDonors()).filter(d => matchesAssignment(assignments, String(d.street_code), d.building));
  const periodTotals = getFullPeriodBreakdown(donors, archiveMap);
  return Object.values(periodTotals).reduce((s, v) => s + v, 0);
}

function setStatus(donorId, status) {
  db.prepare('UPDATE donors SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), donorId);
}

function setAmount(donorId, amount) {
  // מנקים סטטוס קודם - הסכום עצמו כבר משקף שהתורם תרם בפועל
  db.prepare('UPDATE donors SET amount = ?, status = \'\', updated_at = ? WHERE id = ?').run(amount, new Date().toISOString(), donorId);
}

function setUnder20(donorId, flag) {
  db.prepare('UPDATE donors SET under_20 = ? WHERE id = ?').run(flag ? 1 : 0, donorId);
}

function closeCurrentCampaign(closingPeriodName, nextPeriodName) {
  const now = new Date().toISOString();
  const donors = getAllDonors();
  const insertArchive = db.prepare('INSERT INTO campaign_archive (donor_id, amount, manual, status, updated_at, closed_at, period_name) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const resetDonor = db.prepare('UPDATE donors SET amount = 0, manual = 0, status = \'\', updated_at = NULL WHERE id = ?');
  const tx = db.transaction(rows => {
    rows.forEach(d => {
      insertArchive.run(d.id, d.amount || 0, d.manual || 0, d.status || '', d.updated_at, now, closingPeriodName);
      resetDonor.run(d.id);
    });
  });
  tx(donors);
  if (nextPeriodName) setSetting('current_period', nextPeriodName);
  return donors.length;
}

// שולף את כל שורות הארכיון (כל הזמנים, כל המגביות) פעם אחת, ממופה לפי donor_id ואז לפי שם מגבית -
// חוסך שאילתה נפרדת לכל מתרים כשמחשבים פירוט לפי מגבית לכמה מתרים ברצף
function getAllArchiveByDonorAndPeriod() {
  const rows = db.prepare('SELECT donor_id, period_name, amount, manual FROM campaign_archive WHERE period_name != \'\'').all();
  const map = new Map(); // donor_id -> { periodName: amount }
  rows.forEach(r => {
    if (!map.has(r.donor_id)) map.set(r.donor_id, {});
    const perDonor = map.get(r.donor_id);
    perDonor[r.period_name] = (perDonor[r.period_name] || 0) + (r.amount || 0) + (r.manual || 0);
  });
  return map;
}

// סה"כ לפי מגבית (ר"ה/יו"כ/סוכות) לתורמים נתונים - כולל הסכום החי המיוחס למגבית הפעילה כרגע
function getPeriodTotals(donorIds, archiveMap) {
  const totals = {};
  PERIODS.forEach(p => { totals[p] = 0; });
  if (donorIds.length === 0) return totals;

  if (archiveMap) {
    donorIds.forEach(id => {
      const perDonor = archiveMap.get(id);
      if (!perDonor) return;
      Object.entries(perDonor).forEach(([period, amount]) => {
        if (totals[period] === undefined) totals[period] = 0;
        totals[period] += amount;
      });
    });
    return totals;
  }

  const placeholders = donorIds.map(() => '?').join(',');
  const archiveRows = db.prepare(
    `SELECT period_name, amount, manual FROM campaign_archive WHERE donor_id IN (${placeholders}) AND period_name != ''`
  ).all(...donorIds);
  archiveRows.forEach(r => {
    if (totals[r.period_name] === undefined) totals[r.period_name] = 0;
    totals[r.period_name] += (r.amount || 0) + (r.manual || 0);
  });
  return totals;
}

// כמו getPeriodTotals, אבל מקבל את שורות התורמים עצמן (לא רק ID) כדי לצרף גם
// את הסכום החי (שטרם נסגר לארכיון) לתוך המגבית הפעילה כרגע
function getFullPeriodBreakdown(donors, archiveMap) {
  const currentPeriod = getCurrentPeriod();
  const donorIds = donors.map(d => d.id);
  const totals = getPeriodTotals(donorIds, archiveMap);
  const liveTotal = donors.reduce((s, d) => s + (d.amount || 0) + (d.manual || 0), 0);
  if (totals[currentPeriod] === undefined) totals[currentPeriod] = 0;
  totals[currentPeriod] += liveTotal;
  return totals;
}

function getDashboardData() {
  const byPhone = collectorsByPhone();
  const allDonors = getAllDonors();
  const archiveByDonor = getAllArchiveByDonorAndPeriod();
  return Object.values(byPhone).map(c => {
    const stats = donorStatsFor(c.assignments, allDonors);
    const raised = Math.round(monthlyTotalForCollector(c.assignments, allDonors, archiveByDonor));
    return { name: c.name, total: stats.total, completed: stats.completed, needReturn: stats.needReturn, raised, target: c.target || 0 };
  }).sort((a, b) => b.raised - a.raised);
}

// ============================================================================
// API ניהול
// ============================================================================
function checkPin(req, res) {
  if (String(req.query.pin || (req.body && req.body.pin)) !== ADMIN_PIN) {
    res.status(403).json({ error: 'קוד גישה שגוי' });
    return false;
  }
  return true;
}

app.get('/api/admin/close-campaign', (req, res) => {
  if (!checkPin(req, res)) return;
  const closingPeriod = req.query.closingPeriod || getCurrentPeriod();
  const nextPeriod = req.query.nextPeriod || '';
  const count = closeCurrentCampaign(closingPeriod, nextPeriod);
  res.json({ message: `מגבית "${closingPeriod}" נסגרה לארכיון (${count} תורמים).${nextPeriod ? ' המגבית הפעילה כעת: ' + nextPeriod : ''}` });
});

app.get('/api/admin/current-period', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json({ currentPeriod: getCurrentPeriod(), periods: PERIODS });
});

app.get('/api/admin/dashboard', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json(getDashboardData());
});

app.get('/api/admin/find-overlaps', (req, res) => {
  if (!checkPin(req, res)) return;
  const cData = db.prepare('SELECT * FROM collectors').all();
  const byPhone = {};
  cData.forEach(c => {
    const phone = normalizePhone(c.phone);
    if (!byPhone[phone]) byPhone[phone] = { name: c.name, assignments: [] };
    const streetCode = String(c.street_code || '').trim();
    const buildingsRaw = String(c.buildings || '').trim();
    const buildings = buildingsRaw.split(/[,;]/).map(b => b.trim()).filter(Boolean);
    if (streetCode) {
      if (buildings.length === 0) byPhone[phone].assignments.push({ streetCode, building: null });
      else buildings.forEach(b => byPhone[phone].assignments.push({ streetCode, building: b }));
    }
  });

  // כל הצמדים (רחוב+בניין) שקיימים בפועל בנתוני התורמים
  const realPairs = {};
  getAllDonors().forEach(d => {
    const key = String(d.street_code) + '|' + String(d.building);
    realPairs[key] = { streetCode: String(d.street_code), streetName: d.street_name, building: d.building };
  });

  const overlaps = [];
  Object.values(realPairs).forEach(pair => {
    const matchingCollectors = Object.entries(byPhone)
      .filter(([phone, c]) => matchesAssignment(c.assignments, pair.streetCode, pair.building))
      .map(([phone, c]) => `${c.name} (${phone})`);
    if (matchingCollectors.length > 1) {
      overlaps.push({ street: pair.streetName, building: pair.building, collectors: matchingCollectors });
    }
  });

  res.json(overlaps);
});

function computeCollectorsFullData() {
  const cData = db.prepare('SELECT * FROM collectors ORDER BY name').all();

  const byPhone = {};
  cData.forEach(c => {
    const phone = normalizePhone(c.phone);
    if (!byPhone[phone]) {
      byPhone[phone] = {
        name: c.name, phone: c.phone, assignments: [], target: 0, streetsDisplay: [],
        note_before: c.note_before || '', note_after: c.note_after || '', collector_status: c.collector_status || '',
        updater_phone: c.updater_phone || '', collector_code: c.collector_code || '',
        note_before_yomkipur: c.note_before_yomkipur || '', note_after_yomkipur: c.note_after_yomkipur || '',
        collector_status_yomkipur: c.collector_status_yomkipur || '',
      };
    }
    const streetCode = String(c.street_code || '').trim();
    const buildingsRaw = String(c.buildings || '').trim();
    const buildings = buildingsRaw.split(/[,;]/).map(b => b.trim()).filter(Boolean);
    if (streetCode) {
      if (buildings.length === 0) {
        byPhone[phone].assignments.push({ streetCode, building: null });
        byPhone[phone].streetsDisplay.push(`${c.street_name} (כל הבניינים)`);
      } else {
        buildings.forEach(b => byPhone[phone].assignments.push({ streetCode, building: b }));
        byPhone[phone].streetsDisplay.push(`${c.street_name} (בניין ${buildings.join(', ')})`);
      }
    }
    if (c.target > 0) byPhone[phone].target = c.target;
    if (c.note_before) byPhone[phone].note_before = c.note_before;
    if (c.note_after) byPhone[phone].note_after = c.note_after;
    if (c.collector_status) byPhone[phone].collector_status = c.collector_status;
    if (c.updater_phone) byPhone[phone].updater_phone = c.updater_phone;
    if (c.collector_code) byPhone[phone].collector_code = c.collector_code;
    if (c.note_before_yomkipur) byPhone[phone].note_before_yomkipur = c.note_before_yomkipur;
    if (c.note_after_yomkipur) byPhone[phone].note_after_yomkipur = c.note_after_yomkipur;
    if (c.collector_status_yomkipur) byPhone[phone].collector_status_yomkipur = c.collector_status_yomkipur;
  });

  const allDonors = getAllDonors();
  const archiveByDonor = getAllArchiveByDonorAndPeriod();

  return Object.values(byPhone).map(c => {
    const stats = donorStatsFor(c.assignments, allDonors);
    const raised = Math.round(monthlyTotalForCollector(c.assignments, allDonors, archiveByDonor));
    const doneCount = stats.completed + stats.doneNoReturn;
    const donePercent = stats.total > 0 ? Math.round((doneCount / stats.total) * 100) : 100;
    const collectorDonors = allDonors.filter(d => matchesAssignment(c.assignments, String(d.street_code), d.building));
    const periodTotals = getFullPeriodBreakdown(collectorDonors);
    const totalAcrossPeriods = Object.values(periodTotals).reduce((s, v) => s + v, 0);
    const remaining = c.target > 0 ? Math.max(0, c.target - totalAcrossPeriods) : 0;
    return {
      phone: c.phone, name: c.name, street_name: c.streetsDisplay.join(' | '), buildings: '',
      total: stats.total, completed: stats.completed, needReturn: stats.needReturn, notOpened: stats.notOpened, notHandled: stats.notHandled,
      raised, target: c.target || 0, donePercent, remaining, periodTotals,
      note_before: c.note_before, note_after: c.note_after, collector_status: c.collector_status,
      updater_phone: c.updater_phone, collector_code: c.collector_code,
      note_before_yomkipur: c.note_before_yomkipur, note_after_yomkipur: c.note_after_yomkipur,
      collector_status_yomkipur: c.collector_status_yomkipur,
    };
  }).sort((a, b) => a.donePercent - b.donePercent || b.raised - a.raised);
}

app.get('/api/admin/telefonim-view', (req, res) => {
  if (!checkPin(req, res)) return;
  const result = computeCollectorsFullData();
  const allDonors = getAllDonors();
  const archiveByDonor = getAllArchiveByDonorAndPeriod();

  // סיכום אמיתי - ישירות מכל התורמים, בלי תלות בחפיפות בין מתרימים (זוגות וכו')
  let globalTotal = 0, globalCompleted = 0, globalNeedReturn = 0, globalNotOpened = 0, globalNotHandled = 0, globalRaised = 0, globalTarget = 0;
  allDonors.forEach(d => {
    globalTotal++;
    if (hasAmountSet(d)) globalCompleted++;
    else if (d.status === 'לא פתחו') { globalNeedReturn++; globalNotOpened++; }
    else if (d.status === 'ביקשו לבוא פעם אחרת') globalNeedReturn++;
    else if (d.status !== 'פתחו ולא תרמו') globalNotHandled++;
    const donorArchive = archiveByDonor.get(d.id);
    const donorArchiveTotal = donorArchive ? Object.values(donorArchive).reduce((s, v) => s + v, 0) : 0;
    globalRaised += (d.amount || 0) + (d.manual || 0) + donorArchiveTotal;
  });
  globalTarget = result.reduce((s, c) => s + (c.target || 0), 0);

  const summary = {
    totalDonors: globalTotal, totalCompleted: globalCompleted, totalNeedReturn: globalNeedReturn,
    totalNotOpened: globalNotOpened, totalNotHandled: globalNotHandled, totalRaised: Math.round(globalRaised), totalTarget: globalTarget,
    totalCollectors: result.length,
  };

  res.json({ collectors: result, summary });
});

app.get('/api/admin/donors', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json(db.prepare('SELECT * FROM donors ORDER BY street_code, CAST(building AS INTEGER), CAST(apartment AS INTEGER)').all());
});

app.post('/api/admin/donors', (req, res) => {
  if (!checkPin(req, res)) return;
  const { street_code, street_name, building, apartment, donor_code, name, manual } = req.body;
  const info = db.prepare(
    'INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name, manual) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(street_code, street_name, building, apartment, donor_code, name, Number(manual) || 0);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/donors/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  const { street_code, street_name, building, apartment, donor_code, name, manual, status } = req.body;
  db.prepare(
    'UPDATE donors SET street_code = ?, street_name = ?, building = ?, apartment = ?, donor_code = ?, name = ?, manual = ?, status = ? WHERE id = ?'
  ).run(street_code, street_name, building, apartment, donor_code, name, Number(manual) || 0, status || '', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/donors/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  db.prepare('DELETE FROM donors WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/donors', (req, res) => {
  if (!checkPin(req, res)) return;
  db.prepare('DELETE FROM donors').run();
  res.json({ ok: true });
});

app.get('/api/admin/collectors', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json(db.prepare('SELECT * FROM collectors ORDER BY name').all());
});

app.post('/api/admin/collectors', (req, res) => {
  if (!checkPin(req, res)) return;
  const { phone, name, street_code, street_name, buildings, target, note_before, note_after, collector_status } = req.body;
  const info = db.prepare(
    'INSERT INTO collectors (phone, name, street_code, street_name, buildings, target, note_before, note_after, collector_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(normalizePhone(phone), name, street_code, street_name, buildings || '', target || 0, note_before || '', note_after || '', collector_status || '');
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/collectors/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  const { phone, name, street_code, street_name, buildings, target, note_before, note_after, collector_status } = req.body;
  db.prepare(
    'UPDATE collectors SET phone = ?, name = ?, street_code = ?, street_name = ?, buildings = ?, target = ?, note_before = ?, note_after = ?, collector_status = ? WHERE id = ?'
  ).run(normalizePhone(phone), name, street_code, street_name, buildings || '', target || 0, note_before || '', note_after || '', collector_status || '', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/collectors/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  db.prepare('DELETE FROM collectors WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/collectors', (req, res) => {
  if (!checkPin(req, res)) return;
  db.prepare('DELETE FROM collectors').run();
  res.json({ ok: true });
});

// ----- ייבוא CSV דרך הדפדפן (בלי צורך בגישה לשרת עצמו) -----
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // גרשיים כפולים = גרש אחד בתוך שדה מצוטט
        else { inQuotes = false; }
      } else {
        field += char;
      }
    } else {
      if (char === '"') { inQuotes = true; }
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\r') { /* מתעלמים - מטופל יחד עם \n */ }
      else if (char === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else { field += char; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  // מסננים שורות ריקות לגמרי (עלולות להיווצר מרווח בסוף הקובץ)
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

function readCsvText(text) {
  const rows = parseCsvText(text);
  return rows.slice(1).map(row => row.map(cell => cell.trim())); // דילוג על שורת כותרות
}

app.post('/api/admin/import-donors-csv', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const rows = readCsvText(req.body);
    const insert = db.prepare(
      'INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name, amount, manual, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const tx = db.transaction(rows => {
      rows.forEach(r => {
        insert.run(r[0], r[1], r[2], r[3], r[4], r[5], Number(r[6]) || 0, Number(r[7]) || 0, r[8] || '', r[9] || null);
      });
    });
    tx(rows);
    res.json({ message: `יובאו ${rows.length} תורמים.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/import-collectors-csv', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const rows = readCsvText(req.body);
    const insert = db.prepare(
      'INSERT INTO collectors (phone, name, street_name, street_code, buildings, target) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const tx = db.transaction(rows => {
      rows.forEach(r => {
        insert.run(normalizePhone(r[0]), r[1], r[2], r[3], r[4] || '', Number(r[5]) || 0);
      });
    });
    tx(rows);
    res.json({ message: `יובאו ${rows.length} מתרימים.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- סנכרון חי מגוגל שיטס (בלי הורדת CSV ידנית) -----
// דורש שהגיליון משותף כ"כל מי שיש לו את הקישור - צפייה" לפחות.
function sheetCsvUrl(spreadsheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

// ----- ייבוא מלא חד-פעמי מהגיליון (כולל סכומים וסטטוסים - מוחק ומחליף הכל) -----
app.post('/api/admin/import-donors-full-from-sheet', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { spreadsheetId, gid } = req.body;
    if (!gid) return res.status(400).json({ error: 'נא למלא את מספר ה-GID של טאב התורמים' });
    const url = sheetCsvUrl(spreadsheetId, gid);
    const response = await fetch(url);
    if (!response.ok) return res.status(500).json({ error: 'לא ניתן לגשת לגיליון - וודא שהוא משותף כ"כל מי שיש לו קישור - צפייה"' });
    const csvText = await response.text();
    const rows = readCsvText(csvText);

    const insert = db.prepare(
      'INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name, amount, manual, status, updated_at, system_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let imported = 0, skipped = 0;
    const tx = db.transaction(rows => {
      db.prepare('DELETE FROM donors').run();
      rows.forEach(r => {
        const [street_code, street_name, building, apartment, donor_code, name, amountRaw, manualRaw, status, updated_at] = r;
        const systemId = r[11] || ''; // L: מזהה קבוע של התורם
        if (!street_code || !building || !donor_code) { skipped++; return; }
        insert.run(street_code, street_name, building, apartment, donor_code, name, Number(amountRaw) || 0, Number(manualRaw) || 0, status || '', updated_at || null, systemId);
        imported++;
      });
    });
    tx(rows);
    res.json({ message: `ייבוא מלא הושלם: ${imported} תורמים יובאו (כולל סכומים וסטטוסים), ${skipped} שורות דולגו (חסר קוד רחוב/בניין/קוד תורם).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sync-donors-from-sheet', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { spreadsheetId, gid } = req.body;
    const url = sheetCsvUrl(spreadsheetId, gid || '0');
    const response = await fetch(url);
    if (!response.ok) return res.status(500).json({ error: 'לא ניתן לגשת לגיליון - וודא שהוא משותף כ"כל מי שיש לו קישור - צפייה"' });
    const csvText = await response.text();
    const rows = readCsvText(csvText);

    const findExisting = db.prepare('SELECT id, amount FROM donors WHERE street_code = ? AND building = ? AND donor_code = ?');
    const updateFull = db.prepare('UPDATE donors SET street_name = ?, apartment = ?, name = ?, amount = ?, manual = ?, status = ?, system_id = ? WHERE id = ?');
    const insertNew = db.prepare('INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name, amount, manual, status, system_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

    let updated = 0, created = 0, amountsAdopted = 0, skipped = 0;
    const skippedNames = [];
    console.log(`[sync-donors] מתחיל, סה"כ שורות מהגיליון: ${rows.length}`);
    const tx = db.transaction(rows => {
      rows.forEach((r, idx) => {
        const [street_code, street_name, building, apartment, donor_code, name, amountRaw, manualRaw, statusRaw] = r;
        const systemId = r[11] || ''; // L: מזהה קבוע של התורם
        if (idx < 5) {
          console.log(`[sync-donors] שורה ${idx}: name=${name} | r[9]=${JSON.stringify(r[9])} r[10]=${JSON.stringify(r[10])} r[11]=${JSON.stringify(r[11])} r[12]=${JSON.stringify(r[12])} | סה"כ עמודות=${r.length}`);
        }
        if (!street_code || !building || !donor_code) {
          skipped++;
          skippedNames.push(`${name || '(ללא שם)'} - ${street_name || ''} בניין ${building || '?'}`);
          console.log(`[sync-donors] שורה ${idx} דולגה - חסר מידע. תוכן: ${JSON.stringify(r)}`);
          return;
        }
        const sheetAmount = Number(amountRaw) || 0;
        const sheetManual = Number(manualRaw) || 0;
        const sheetStatus = statusRaw || '';
        const existing = findExisting.get(street_code, building, donor_code);

        if (existing) {
          const existingAmount = existing.amount || 0;
          // הסכום הרגיל (טלפוני) מוגן ברגע שיש לו ערך אמיתי - לא נדרס יותר מהגיליון.
          // תרומה ידנית וסטטוס תמיד באחריות הגיליון - נכתבים מחדש בכל סנכרון.
          const newAmount = existingAmount > 0 ? existingAmount : sheetAmount;
          if (newAmount > 0 && existingAmount === 0) amountsAdopted++;
          updateFull.run(street_name, apartment, name, newAmount, sheetManual, sheetStatus, systemId, existing.id);
          updated++;
        } else {
          insertNew.run(street_code, street_name, building, apartment, donor_code, name, sheetAmount, sheetManual, sheetStatus, systemId);
          created++;
        }
      });
    });
    tx(rows);
    console.log(`[sync-donors] סיום. עודכנו: ${updated}, נוצרו: ${created}, דולגו: ${skipped}`);

    let message = `סונכרן: ${updated} תורמים עודכנו (מתוכם ${amountsAdopted} אימצו סכום מהגיליון), ${created} תורמים חדשים נוספו.`;
    if (skipped > 0) {
      message += ` ${skipped} שורות דולגו כי חסר להן קוד רחוב/בניין/קוד תורם: ${skippedNames.slice(0, 20).join(' | ')}${skipped > 20 ? ' ...ועוד' : ''}`;
    }
    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sync-collectors-from-sheet', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { spreadsheetId, gid } = req.body;
    if (!gid) return res.status(400).json({ error: 'נא למלא את מספר ה-GID של טאב המתרימים' });
    const url = sheetCsvUrl(spreadsheetId, gid);
    const response = await fetch(url);
    if (!response.ok) return res.status(500).json({ error: 'לא ניתן לגשת לגיליון - וודא שהוא משותף כ"כל מי שיש לו קישור - צפייה"' });
    const csvText = await response.text();
    const rows = readCsvText(csvText);

    const insert = db.prepare('INSERT INTO collectors (phone, name, street_name, street_code, buildings, target, note_before, note_after, collector_status, updater_phone, collector_code, note_before_yomkipur, note_after_yomkipur, collector_status_yomkipur) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let rowIdx = 0;
    const tx = db.transaction(rows => {
      db.prepare('DELETE FROM collectors').run();
      rows.forEach(r => {
        const phone = r[3];   // D: טלפון מתרים
        if (!phone) return;
        const name = r[4];              // E: שם הגובה
        const street_name = r[5];       // F: שם רחוב
        const street_code = r[0];       // A: קוד רחוב
        const collector_code = r[1] || '';  // B: "מזהה1" - קוד המתרים
        const buildings = r[6] || '';   // G: אחראי על בנינים
        const target = Number(r[7]) || 0; // H: סכום יעד כללי
        const noteBefore = r[18] || '';   // S: "תשובה לטלפן תזכורת לגביה" - לפני הגבייה
        const noteAfter = r[19] || '';    // T: "תשובה לטלפן אחרי הגביה"
        const collectorStatus = r[20] || ''; // "לעקוב אחרי הגביה" - סטטוס טיפול טלפנים
        const updaterPhone = r[44] || '';  // AS: נייד של מי שמעדכן את התרומות (אם המתרים לא מעדכן בעצמו)
        const noteBeforeYomKipur = r[53] || '';   // BB: תשובה לפני הגביה - יום כיפור
        const noteAfterYomKipur = r[54] || '';    // BC: תשובה אחרי הגביה - יום כיפור
        const collectorStatusYomKipur = r[55] || ''; // BD: סטטוס טיפול טלפנים - יום כיפור
        if (rowIdx < 5) {
          console.log(`[sync-collectors] שורה ${rowIdx}: phone=${phone} name=${name} | r[18]=${JSON.stringify(r[18])} r[19]=${JSON.stringify(r[19])} r[20]=${JSON.stringify(r[20])} | סה"כ עמודות בשורה=${r.length}`);
        }
        rowIdx++;
        insert.run(normalizePhone(phone), name, street_name, street_code, buildings, target, noteBefore, noteAfter, collectorStatus, updaterPhone, collector_code, noteBeforeYomKipur, noteAfterYomKipur, collectorStatusYomKipur);
      });
    });
    tx(rows);
    res.json({ message: `סונכרנו ${rows.length} מתרימים (הוחלפו במלואם).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// עזר לימות
// ============================================================================
function escTts(text) {
  return String(text || '').replace(/[.\-]/g, ' ');
}

function readBuild(promptSegment, baseName, opts, state) {
  opts = opts || {};
  state.pc = (state.pc || 0) + 1;
  const paramName = baseName + '_' + state.pc;
  state.expectKey = paramName;

  const fields = [
    paramName, '', opts.max || '', opts.min || '', opts.timeout || '', opts.say || 'Number',
    '', '', '', '', '',
    opts.okOnEmpty ? 'Ok' : '', '', '',
    opts.confirmEntry ? '' : 'no',
  ];
  return 'read=' + promptSegment + '=' + fields.join(',');
}

// ============================================================================
// ייצוא תקופתי לטאב "טלפנים" בגוגל שיטס (עמודות K-N בלבד) - דרך Apps Script
// פשוט בהרבה מ-Google Cloud Service Account: שולחים בקשה ל-Apps Script קטן
// שכבר יש לו הרשאה לערוך את הגיליון שלו, בלי אישורים נוספים.
// ============================================================================
const XLSX = require('xlsx');

app.get('/api/admin/export-excel/donors', (req, res) => {
  if (!checkPin(req, res)) return;
  const donors = db.prepare('SELECT id, street_code, street_name, building, apartment, donor_code, name, amount, manual, status, updated_at, under_20, system_id FROM donors ORDER BY street_code, CAST(building AS INTEGER), CAST(apartment AS INTEGER)').all();
  const headers = ['מזהה', 'קוד רחוב', 'שם רחוב', 'בניין', 'דירה', 'קוד תורם', 'שם', 'סכום', 'תרומה ידנית', 'סטטוס', 'תאריך עדכון', 'מתחת ל-20', 'מזהה קבוע'];
  const rows = donors.map(d => [d.id, d.street_code, d.street_name, d.building, d.apartment, d.donor_code, d.name, d.amount, d.manual, d.status, d.updated_at, d.under_20 ? 'כן' : '', d.system_id]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'תורמים');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="torvim.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

app.get('/api/admin/export-excel/collectors', (req, res) => {
  if (!checkPin(req, res)) return;
  const data = computeCollectorsFullData();
  const periodNames = PERIODS; // ['ראש השנה', 'יום כיפור', 'סוכות']
  const headers = [
    'טלפון', 'שם', 'קוד מתרים', 'רחוב', 'יעד', 'נאסף (סה"כ)', 'נותר להשלמה',
    'סך תורמים', 'השלימו', 'צריך לחזור (סה"כ)', 'מתוכם לא פתחו', 'לא טופלו כלל', 'אחוז שכנים שטופלו',
    ...periodNames.map(p => `נאסף ${p}`),
    'תשובה לפני הגבייה', 'תשובה אחרי הגבייה', 'סיווג סטטוס', 'נייד מעדכן',
    'תשובה לפני הגבייה - יוכ', 'תשובה אחרי הגבייה - יוכ', 'סיווג סטטוס - יוכ',
  ];
  const rows = data.map(c => [
    c.phone, c.name, c.collector_code, c.street_name, c.target, c.raised, c.remaining,
    c.total, c.completed, c.needReturn, c.notOpened, c.notHandled, c.donePercent + '%',
    ...periodNames.map(p => c.periodTotals[p] || 0),
    c.note_before, c.note_after, c.collector_status, c.updater_phone,
    c.note_before_yomkipur, c.note_after_yomkipur, c.collector_status_yomkipur,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'מתרימים');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="metrimim.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

const TELEFONIM_EXPORT_WEBHOOK_URL = process.env.TELEFONIM_EXPORT_WEBHOOK_URL || '';
const TELEFONIM_EXPORT_SECRET = process.env.TELEFONIM_EXPORT_SECRET || '';

async function syncTelefonimSheet() {
  if (!TELEFONIM_EXPORT_WEBHOOK_URL) return { error: 'TELEFONIM_EXPORT_WEBHOOK_URL לא מוגדר בשרת' };
  try {
    const byPhone = collectorsByPhone();
    const allDonors = getAllDonors();
    const archiveByDonor = getAllArchiveByDonorAndPeriod();

    const collectorsPayload = Object.entries(byPhone).map(([phone, c]) => {
      const stats = donorStatsFor(c.assignments, allDonors);
      const raised = Math.round(monthlyTotalForCollector(c.assignments, allDonors, archiveByDonor));
      return { phone, total: stats.total, completed: stats.completed, needReturn: stats.needReturn, raised };
    });

    const response = await fetch(TELEFONIM_EXPORT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TELEFONIM_EXPORT_SECRET, collectors: collectorsPayload }),
    });
    const result = await response.json();
    if (result.error) console.error('שגיאה בייצוא טלפנים:', result.error);
    else console.log(`ייצוא טלפנים: ${result.message}`);
    return result;
  } catch (err) {
    console.error('שגיאה בייצוא טלפנים:', err.message);
    return { error: err.message };
  }
}

// הפעלה תקופתית כל 5 דקות
setInterval(syncTelefonimSheet, 5 * 60 * 1000);
setTimeout(syncTelefonimSheet, 15 * 1000);

// אפשרות לייצוא ידני דרך דפדפן/כפתור
app.get('/api/admin/sync-telefonim', async (req, res) => {
  if (!checkPin(req, res)) return;
  const result = await syncTelefonimSheet();
  if (result && result.error) return res.status(500).json({ error: result.error });
  res.json({ message: (result && result.message) || 'ייצוא טלפנים בוצע.' });
});

// ============================================================================
app.get('/', (req, res) => res.redirect('/admin.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Trumot server (v2, SQLite) running on port ' + PORT));
