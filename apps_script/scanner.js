// filename: apps-script/scanner.gs

const SECRET_API_KEY = PropertiesService.getScriptProperties().getProperty('API_KEY');
const USE_LIBRARY = false;
const LIB = this.IngestLib || null;

// helper định dạng ngày/giờ theo TZ
function fmtDate_(d, tz) {
  tz = tz || (Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh');
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}
function fmtTime_(d, tz) {
  tz = tz || (Session.getScriptTimeZone() || 'Asia/Ho_Chi_Minh');
  return Utilities.formatDate(d, tz, 'HH:mm:ss');
}

// filename: apps-script/scanner.gs
/* [UPDATED] scanGmail(): gom payload và gọi appendExpenses() 1 lần; fallback per-item nếu batch lỗi */
// [UPDATED] scanGmail(): xử lý theo *message*, lọc theo cutoff + hasLabel, dán nhãn từng mail
// filename: apps-script/scanner.gs
/* [UPDATED] scanGmail(): duyệt message theo ngày, nhưng check/dán nhãn ở cấp thread */
/* [UPDATED] scanGmail(): check nhãn bằng getLabels(); dán nhãn theo thread */
function scanGmail() {
  const TEST_MODE = false;
  const LABEL_PROCESSED = "expense_processed";
  const MAX_THREADS = 50;
  const query =
    "from:(no-reply@vpbank.com OR alert@vpbank.com OR customercare@care.vpb.com.vn OR HSBC@notification.hsbc.com.hk) "
    + "newer_than:1d "
    // + "-label:" + LABEL_PROCESSED
    ;

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const threads = GmailApp.search(query, 0, MAX_THREADS);
  const label = GmailApp.getUserLabelByName(LABEL_PROCESSED) || GmailApp.createLabel(LABEL_PROCESSED);

  const results = [];
  const batch = [];
  const threadsToLabel = [];

  // helper: thread có nhãn?
  const hasThreadLabel = (th, name) => th.getLabels().some(l => l.getName() === name);

  threads.forEach(function (th) {
    // Phòng hờ: nếu đã có nhãn thì bỏ (query đã -label, nhưng check thêm cho chắc)
    // if (hasThreadLabel(th, LABEL_PROCESSED)) return;

    const before = batch.length;

    th.getMessages().forEach(function (msg) {
      const d = msg.getDate && msg.getDate();
      if (!d || d < cutoff) return;

      const from = String(msg.getFrom ? msg.getFrom() : "");
      if (!/no-reply@vpbank\.com|alert@vpbank\.com|customercare@care\.vpb\.com\.vn|HSBC@notification\.hsbc\.com\.hk/i.test(from)) return;

      const body = (msg.getPlainBody && msg.getPlainBody()) || "";
      const html = !body && msg.getBody ? msg.getBody() : "";
      const plain = body || stripHtml_(html);
      if (!plain) return;

      const em = { from, subject: String(msg.getSubject ? msg.getSubject() : ""), body: plain };
      const rec = ParserRegistry.parse(em);
      if (!rec) return;

      const tz = Session.getScriptTimeZone() || "Asia/Ho_Chi_Minh";
      const dateISO = rec.date ? String(rec.date) : Utilities.formatDate(d, tz, "yyyy-MM-dd");
      const timeISO = Utilities.formatDate(d, tz, "HH:mm:ss");

      const payload = {
        user_id: String(extractUserId_(em.from)),
        date: dateISO,
        time: timeISO,
        amount: rec.amount,
        merchant: rec.merchant,
        category: rec.category,
        note: rec.note || "",
        source: "email",
        raw: em.body,
      };

      if (TEST_MODE) {
        results.push({ parsed: rec, subject: em.subject, from: em.from, bodyPreview: em.body.slice(0, 300) });
      } else {
        batch.push(payload);
      }
    });

    if (!TEST_MODE && batch.length > before) {
      threadsToLabel.push(th);
    }
  });

  if (TEST_MODE) return results;
  if (!batch.length) return [];

  try {
    const ids = (USE_LIBRARY && LIB && typeof LIB.appendExpenses === "function")
      ? LIB.appendExpenses(batch, SECRET_API_KEY)
      : appendExpenses(batch, SECRET_API_KEY);

    // Dán nhãn các thread đã ghi dữ liệu
    if (threadsToLabel.length) label.addToThreads(threadsToLabel);
    Logger.log("[BATCH APPENDED] count=%s", ids.length);
  } catch (e) {
    Logger.log("[ERROR] batch append failed: %s", e);
    // Fallback per-item
    batch.forEach(function (p) { try { appendExpense(p, SECRET_API_KEY); } catch (ex) { Logger.log("[ERROR] fallback append failed: %s", ex); } });
    if (threadsToLabel.length) label.addToThreads(threadsToLabel);
  }
  return [];
}


function stripHtml_(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUserId_(from) { return PropertiesService.getScriptProperties().getProperty('ME_TELEGRAM_ID'); }
