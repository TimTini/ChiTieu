// filename: apps-script/scanner.gs
// Gọi trực tiếp appendExpense (nếu cùng project) hoặc qua Library (nếu khác project).
// Nếu dùng Library, đặt identifier ví dụ: IngestLib, rồi gọi IngestLib.appendExpense(...)

const SECRET_API_KEY = PropertiesService.getScriptProperties().getProperty('API_KEY');
const USE_LIBRARY = false;         // true nếu bạn đã add Library (identifier: IngestLib)
const LIB = this.IngestLib || null; // đổi theo identifier khi add Library

function scanGmail() {
  const TEST_MODE = false;
  const LABEL_PROCESSED = 'expense_processed';
  const MAX_THREADS = 50;

  const query =
    'from:(no-reply@vpbank.com OR alert@vpbank.com OR customercare@care.vpb.com.vn OR HSBC@notification.hsbc.com.hk) ' +
    'newer_than:7d -label:' + LABEL_PROCESSED;

  const threads = GmailApp.search(query, 0, MAX_THREADS);
  const label = GmailApp.getUserLabelByName(LABEL_PROCESSED) || GmailApp.createLabel(LABEL_PROCESSED);

  const results = [];

  threads.forEach((th) => {
    th.getMessages().forEach((msg) => {
      const body = (msg.getPlainBody && msg.getPlainBody()) || '';
      const html = !body && msg.getBody ? msg.getBody() : '';
      const plain = body || stripHtml_(html);
      if (!plain) {
        if (TEST_MODE) Logger.log('[SKIP] Empty body: %s', msg.getId());
        return;
      }

      /** @type {EmailMessage} */
      const em = {
        from: String(msg.getFrom ? msg.getFrom() : ''),
        subject: String(msg.getSubject ? msg.getSubject() : ''),
        body: plain,
      };

      const rec = ParserRegistry.parse(em);
      if (!rec) {
        if (TEST_MODE) Logger.log('[UNPARSED] from=%s subject=%s', em.from, em.subject);
        return;
      }

      if (TEST_MODE) {
        results.push({ parsed: rec, subject: em.subject, from: em.from, bodyPreview: em.body.slice(0, 300) });
        Logger.log(JSON.stringify(results[results.length - 1]));
        return;
      }

      // ---- GHI TRỰC TIẾP VÀO SHEET (không HTTP) ----
      const payload = {
        user_id: String(extractUserId_(em.from)),
        date: rec.date,
        amount: rec.amount,
        merchant: rec.merchant,
        category: rec.category,
        note: rec.note || '',
        source: 'email',
        raw: em.body,
      };

      try {
        const id = USE_LIBRARY
          ? LIB.appendExpense(payload, SECRET_API_KEY) // khác project: gọi qua Library
          : appendExpense(payload, SECRET_API_KEY);    // cùng project: gọi trực tiếp

        th.addLabel(label);
        Logger.log('[APPENDED] id=%s amount=%s merchant=%s', id, rec.amount, rec.merchant);
      } catch (e) {
        Logger.log('[ERROR] appendExpense msgId=%s err=%s', msg.getId(), e);
      }
    });
  });

  return results;
}

function stripHtml_(h) { return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function extractUserId_(from) { return PropertiesService.getScriptProperties().getProperty('ME_TELEGRAM_ID'); }
