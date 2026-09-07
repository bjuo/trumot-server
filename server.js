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
    const list = getSortedDonors(state.assignments);
    if (list.length === 0) {
      state.step = 'menu';
      return 'id_list_message=t-כל התורמים ברחובות שלך כבר הושלמו&' + mainMenuRead(state);
    }
    state.step = 'seq_action';
    state.seqList = list.map(d => d.id);
    state.seqIndex = 0;
    return announceDonorAndAsk(state.seqList[0], state);
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

// ============================================================================
// אפשרות 1 (וגם אפשרות 4 תת-אפשרות 2): הקראה רציפה
// ============================================================================
function announceDonorAndAsk(donorId, state) {
  const d = getDonorById(donorId);
  const msg =
    `t-רחוב ${escTts(d.street_name)} בניין ${d.building}, דירה` + '.' +
    `n-${d.apartment}` + '.' +
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
    state.step = 'menu';
    return 'id_list_message=t-עודכן בהצלחה&' + mainMenuRead(state);
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
  state.step = 'menu';
  return 'id_list_message=t-עודכן בהצלחה&' + mainMenuRead(state);
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
  const msg = 't-לסימון לא פתחו את הדלת לכולם הקישו 1, לסימון ביקשו לבוא פעם אחרת לכולם הקישו 2, לסימון פתחו ולא תרמו לכולם הקישו 3, לחזרה לתפריט הראשי הקישו כוכבית';
  return readBuild(msg, 'BatchStatus', { max: 1, min: 1, say: 'NO' }, state);
}

function handleBatchStatus(choice, state) {
  if (choice === '*') {
    state.step = 'menu';
    return mainMenuRead(state);
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
    const buildings = buildingsRaw.split(',').map(b => b.trim()).filter(Boolean);
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

function donorStatsFor(assignments) {
  let total = 0, completed = 0, needReturn = 0, doneNoReturn = 0;
  getAllDonors().forEach(d => {
    if (!matchesAssignment(assignments, String(d.street_code), d.building)) return;
    total++;
    if (hasAmountSet(d)) completed++;
    else if (d.status === 'ביקשו לבוא פעם אחרת' || d.status === 'לא פתחו') needReturn++;
    else if (d.status === 'פתחו ולא תרמו') doneNoReturn++;
  });
  return { total, completed, needReturn, doneNoReturn };
}

function monthlyTotalForCollector(assignments) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const donors = getAllDonors().filter(d => matchesAssignment(assignments, String(d.street_code), d.building));
  let total = donors.reduce((s, d) => s + (d.amount || 0) + (d.manual || 0), 0);

  const ids = donors.map(d => d.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const archiveRows = db.prepare(
      `SELECT amount, manual FROM campaign_archive WHERE donor_id IN (${placeholders}) AND closed_at >= ?`
    ).all(...ids, startOfMonth);
    total += archiveRows.reduce((s, r) => s + (r.amount || 0) + (r.manual || 0), 0);
  }
  return total;
}

function setStatus(donorId, status) {
  db.prepare('UPDATE donors SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), donorId);
}

function setAmount(donorId, amount) {
  // מנקים סטטוס קודם - הסכום עצמו כבר משקף שהתורם תרם בפועל
  db.prepare('UPDATE donors SET amount = ?, status = \'\', updated_at = ? WHERE id = ?').run(amount, new Date().toISOString(), donorId);
}

function closeCurrentCampaign() {
  const now = new Date().toISOString();
  const donors = getAllDonors();
  const insertArchive = db.prepare('INSERT INTO campaign_archive (donor_id, amount, manual, status, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?)');
  const resetDonor = db.prepare('UPDATE donors SET amount = 0, manual = 0, status = \'\', updated_at = NULL WHERE id = ?');
  const tx = db.transaction(rows => {
    rows.forEach(d => {
      insertArchive.run(d.id, d.amount || 0, d.manual || 0, d.status || '', d.updated_at, now);
      resetDonor.run(d.id);
    });
  });
  tx(donors);
  return donors.length;
}

function getDashboardData() {
  const byPhone = collectorsByPhone();
  return Object.values(byPhone).map(c => {
    const stats = donorStatsFor(c.assignments);
    const raised = Math.round(monthlyTotalForCollector(c.assignments));
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
  const count = closeCurrentCampaign();
  res.json({ message: `מגבית נסגרה לארכיון ונפתחה מגבית חדשה ריקה, ${count} תורמים.` });
});

app.get('/api/admin/dashboard', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json(getDashboardData());
});

app.get('/api/admin/telefonim-view', (req, res) => {
  if (!checkPin(req, res)) return;
  const cData = db.prepare('SELECT * FROM collectors ORDER BY name').all();

  const byPhone = {};
  cData.forEach(c => {
    const phone = normalizePhone(c.phone);
    if (!byPhone[phone]) byPhone[phone] = { name: c.name, phone: c.phone, assignments: [], target: 0, streetsDisplay: [] };
    const streetCode = String(c.street_code || '').trim();
    const buildingsRaw = String(c.buildings || '').trim();
    const buildings = buildingsRaw.split(',').map(b => b.trim()).filter(Boolean);
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
  });

  const result = Object.values(byPhone).map(c => {
    const stats = donorStatsFor(c.assignments);
    const raised = Math.round(monthlyTotalForCollector(c.assignments));
    const doneCount = stats.completed + stats.doneNoReturn;
    const donePercent = stats.total > 0 ? Math.round((doneCount / stats.total) * 100) : 100;
    return {
      phone: c.phone, name: c.name, street_name: c.streetsDisplay.join(' | '), buildings: '',
      total: stats.total, completed: stats.completed, needReturn: stats.needReturn,
      raised, target: c.target || 0, donePercent,
    };
  }).sort((a, b) => a.donePercent - b.donePercent || b.raised - a.raised);

  res.json(result);
});

app.get('/api/admin/donors', (req, res) => {
  if (!checkPin(req, res)) return;
  res.json(db.prepare('SELECT * FROM donors ORDER BY street_code, CAST(building AS INTEGER), CAST(apartment AS INTEGER)').all());
});

app.post('/api/admin/donors', (req, res) => {
  if (!checkPin(req, res)) return;
  const { street_code, street_name, building, apartment, donor_code, name } = req.body;
  const info = db.prepare(
    'INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(street_code, street_name, building, apartment, donor_code, name);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/donors/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  const { street_code, street_name, building, apartment, donor_code, name } = req.body;
  db.prepare(
    'UPDATE donors SET street_code = ?, street_name = ?, building = ?, apartment = ?, donor_code = ?, name = ? WHERE id = ?'
  ).run(street_code, street_name, building, apartment, donor_code, name, req.params.id);
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
  const { phone, name, street_code, street_name, buildings, target } = req.body;
  const info = db.prepare(
    'INSERT INTO collectors (phone, name, street_code, street_name, buildings, target) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(normalizePhone(phone), name, street_code, street_name, buildings || '', target || 0);
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/admin/collectors/:id', (req, res) => {
  if (!checkPin(req, res)) return;
  const { phone, name, street_code, street_name, buildings, target } = req.body;
  db.prepare(
    'UPDATE collectors SET phone = ?, name = ?, street_code = ?, street_name = ?, buildings = ?, target = ? WHERE id = ?'
  ).run(normalizePhone(phone), name, street_code, street_name, buildings || '', target || 0, req.params.id);
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
function parseCsvLine(line) {
  return line.split(',').map(cell => cell.replace(/^"|"$/g, '').trim());
}
function readCsvText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  return lines.slice(1).map(parseCsvLine); // דילוג על שורת כותרות
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
function sheetCsvUrl(spreadsheetId, sheetName) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
}

app.post('/api/admin/sync-donors-from-sheet', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { spreadsheetId, sheetName } = req.body;
    const url = sheetCsvUrl(spreadsheetId, sheetName || 'תורמים');
    const response = await fetch(url);
    if (!response.ok) return res.status(500).json({ error: 'לא ניתן לגשת לגיליון - וודא שהוא משותף כ"כל מי שיש לו קישור - צפייה"' });
    const csvText = await response.text();
    const rows = readCsvText(csvText);

    const findExisting = db.prepare('SELECT id FROM donors WHERE street_code = ? AND building = ? AND apartment = ?');
    const updateBasic = db.prepare('UPDATE donors SET street_name = ?, donor_code = ?, name = ? WHERE id = ?');
    const insertNew = db.prepare('INSERT INTO donors (street_code, street_name, building, apartment, donor_code, name) VALUES (?, ?, ?, ?, ?, ?)');

    let updated = 0, created = 0;
    const tx = db.transaction(rows => {
      rows.forEach(r => {
        const [street_code, street_name, building, apartment, donor_code, name] = r;
        if (!street_code || !building || !apartment) return; // שורה חסרה - מדלגים
        const existing = findExisting.get(street_code, building, apartment);
        if (existing) {
          updateBasic.run(street_name, donor_code, name, existing.id);
          updated++;
        } else {
          insertNew.run(street_code, street_name, building, apartment, donor_code, name);
          created++;
        }
      });
    });
    tx(rows);
    res.json({ message: `סונכרן: ${updated} תורמים עודכנו, ${created} תורמים חדשים נוספו. הסכום והסטטוס הקיימים לא נפגעו.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sync-collectors-from-sheet', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { spreadsheetId, sheetName } = req.body;
    const url = sheetCsvUrl(spreadsheetId, sheetName || 'מתרימים');
    const response = await fetch(url);
    if (!response.ok) return res.status(500).json({ error: 'לא ניתן לגשת לגיליון - וודא שהוא משותף כ"כל מי שיש לו קישור - צפייה"' });
    const csvText = await response.text();
    const rows = readCsvText(csvText);

    const insert = db.prepare('INSERT INTO collectors (phone, name, street_name, street_code, buildings, target) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(rows => {
      db.prepare('DELETE FROM collectors').run();
      rows.forEach(r => {
        if (!r[0]) return;
        insert.run(normalizePhone(r[0]), r[1], r[2], r[3], r[4] || '', Number(r[5]) || 0);
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
// סנכרון תקופתי לטאב "טלפנים" בגוגל שיטס (עמודות K-P בלבד)
// ============================================================================
const { google } = require('googleapis');

const TELEFONIM_SPREADSHEET_ID = process.env.TELEFONIM_SPREADSHEET_ID || '';
const TELEFONIM_SHEET_NAME = process.env.TELEFONIM_SHEET_NAME || 'טלפנים';
const TELEFONIM_PHONE_COL_LETTER = 'D';
const TELEFONIM_STATS_RANGE = 'K:P'; // 6 עמודות: סך תורמים, השלימו, צריך לחזור, נאסף, יעד, אחוז
const GOOGLE_SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || '';

let sheetsClient = null;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_KEY_PATH || !fs.existsSync(GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) return null;
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function syncTelefonimSheet() {
  if (!TELEFONIM_SPREADSHEET_ID) return; // לא הוגדר - מדלגים בשקט
  const sheets = getSheetsClient();
  if (!sheets) {
    console.error('סנכרון טלפנים: לא נמצא קובץ מפתח של חשבון שירות (GOOGLE_SERVICE_ACCOUNT_KEY_PATH)');
    return;
  }

  try {
    // קריאת כל מספרי הטלפון בעמודה D
    const phonesResp = await sheets.spreadsheets.values.get({
      spreadsheetId: TELEFONIM_SPREADSHEET_ID,
      range: `${TELEFONIM_SHEET_NAME}!${TELEFONIM_PHONE_COL_LETTER}:${TELEFONIM_PHONE_COL_LETTER}`,
    });
    const phoneRows = phonesResp.data.values || [];
    const byPhone = collectorsByPhone();

    const output = phoneRows.map(row => {
      const rawPhone = row[0];
      if (!rawPhone) return null; // null = לא לגעת בשורה הזו בכלל
      const phone = normalizePhone(String(rawPhone));
      const collector = byPhone[phone];
      if (!collector) return null;

      const stats = donorStatsFor(collector.assignments);
      const raised = Math.round(monthlyTotalForCollector(collector.assignments));
      const target = collector.target || 0;
      const pct = target > 0 ? Math.round((raised / target) * 100) : '';
      return [stats.total, stats.completed, stats.needReturn, raised, target || '', pct !== '' ? pct + '%' : ''];
    });

    // כותבים רק לשורות שבאמת נמצאה בהן התאמה (data ל-batchUpdate עם null מדלג על התא)
    const requests = output.map((vals, i) => {
      if (!vals) return null;
      return {
        range: `${TELEFONIM_SHEET_NAME}!K${i + 1}:P${i + 1}`,
        values: [vals],
      };
    }).filter(Boolean);

    if (requests.length === 0) return;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: TELEFONIM_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: requests },
    });

    console.log(`סנכרון טלפנים: עודכנו ${requests.length} שורות`);
  } catch (err) {
    console.error('שגיאה בסנכרון טלפנים:', err.message);
  }
}

// הפעלה תקופתית כל 5 דקות, בדיוק כמו הטריגר שהיה ב-Apps Script
setInterval(syncTelefonimSheet, 5 * 60 * 1000);
// הרצה ראשונה קצרה אחרי עליית השרת (לא מיידית, נותן לשרת להתייצב)
setTimeout(syncTelefonimSheet, 15 * 1000);

// אפשרות לרענון ידני דרך דפדפן/כפתור
app.get('/api/admin/sync-telefonim', async (req, res) => {
  if (!checkPin(req, res)) return;
  await syncTelefonimSheet();
  res.json({ message: 'סנכרון טלפנים בוצע.' });
});

// ============================================================================
app.get('/', (req, res) => res.redirect('/admin.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Trumot server (v2, SQLite) running on port ' + PORT));
