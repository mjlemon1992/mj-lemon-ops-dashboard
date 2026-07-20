// Read scanned vendor invoices out of an email inbox (ScanSnap "scan to email"
// front door). Pulls PDF/image attachments from UNSEEN messages via IMAP + a
// Gmail app password — the same auth style as lib/inbox.js (no OAuth server).
// Read-only except for setting \Seen on messages we successfully processed so
// they aren't ingested twice. Nothing is deleted, moved, or archived.
const { ImapFlow } = require('imapflow');

const OK_ATTACH = (mt) => /^application\/pdf$/i.test(mt) || /^image\/(jpe?g|png|webp|gif|heic|heif)$/i.test(mt);

const streamToBuffer = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
});

// Walk an ImapFlow bodyStructure tree, collecting attachment-like leaf nodes
// (PDFs/images carried as attachments). Handles both multipart and single-part.
function collectAttachments(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node.childNodes) && node.childNodes.length) {
    node.childNodes.forEach((c) => collectAttachments(c, out));
    return out;
  }
  const mt = `${node.type || ''}/${node.subtype || ''}`.toLowerCase();
  const disp = String(node.disposition || '').toLowerCase();
  const dp = node.dispositionParameters || {};
  const pp = node.parameters || {};
  const filename = dp.filename || dp.FILENAME || pp.name || pp.NAME || null;
  if (OK_ATTACH(mt) && (disp === 'attachment' || filename)) {
    out.push({ part: node.part || '1', mediaType: mt, filename: filename || `scan.${node.subtype || 'bin'}` });
  }
  return out;
}

// Returns { ok, error, messages:[{ uid, subject, from, date, attachments:[{part, mediaType, filename, base64}] }] }.
// Only messages that actually carry a usable attachment are returned.
async function fetchInvoiceEmails({ user, pass, subjectTag = '', sinceDays = 21, max = 25 } = {}) {
  if (!user || !pass) return { ok: false, error: 'IMAP user/pass not set', messages: [] };
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false, emitLogs: false });
  const messages = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - sinceDays * 86400 * 1000);
      const criteria = { seen: false, since };
      if (subjectTag) criteria.subject = subjectTag;
      const uids = await client.search(criteria, { uid: true });
      const pick = (Array.isArray(uids) ? uids : []).slice(-max);
      for (const uid of pick) {
        const msg = await client.fetchOne(uid, { uid: true, envelope: true, bodyStructure: true }, { uid: true });
        if (!msg) continue;
        const atts = collectAttachments(msg.bodyStructure);
        if (!atts.length) continue;
        for (const a of atts) {
          try {
            const dl = await client.download(uid, a.part, { uid: true });
            a.base64 = (await streamToBuffer(dl.content)).toString('base64');
          } catch (e) { a.error = e.message; }
        }
        const usable = atts.filter((a) => a.base64);
        if (!usable.length) continue;
        const from = msg.envelope && msg.envelope.from && msg.envelope.from[0];
        messages.push({
          uid,
          subject: (msg.envelope && msg.envelope.subject) || '(no subject)',
          from: (from && from.address) || '',
          date: msg.envelope && msg.envelope.date,
          attachments: usable,
        });
      }
    } finally { lock.release(); }
    return { ok: true, messages };
  } catch (e) {
    return { ok: false, error: e.message, messages: [] };
  } finally {
    try { await client.logout(); } catch (e) { /* ignore */ }
  }
}

// Mark processed messages \Seen so they aren't re-ingested. Read-state only.
async function markSeen({ user, pass, uids } = {}) {
  const list = (Array.isArray(uids) ? uids : [uids]).map(Number).filter(Boolean);
  if (!user || !pass || !list.length) return { ok: false, marked: 0 };
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false, emitLogs: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try { await client.messageFlagsAdd(list, ['\\Seen'], { uid: true }); }
    finally { lock.release(); }
    return { ok: true, marked: list.length };
  } catch (e) {
    return { ok: false, marked: 0, error: e.message };
  } finally {
    try { await client.logout(); } catch (e) { /* ignore */ }
  }
}

module.exports = { fetchInvoiceEmails, markSeen };
