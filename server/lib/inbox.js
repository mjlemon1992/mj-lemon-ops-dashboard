// Read-only Gmail access for the always-on morning brief, via IMAP + a Gmail
// app password (no OAuth server). Pulls recent inbox + flags the ones that
// carry the "⚡ Action Needed" label or come from high-value senders.
const { ImapFlow } = require('imapflow');

const HIGH_VALUE = ['warrensinclair.com', 'rbc.com', 'doane.gt.ca', 'intuit.com', 'thebookboss.ca'];
const ACTION_LABELS = ['⚡ Action Needed', 'Action Needed'];

// Returns { ok, error, threads:[{subject, fromName, from, date, unread, actionNeeded}] }
async function recentInbox({ user, pass, sinceDays = 4, max = 25 } = {}) {
  if (!user || !pass) return { ok: false, error: 'GMAIL_IMAP_USER / GMAIL_IMAP_PASS not set', threads: [] };
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false, emitLogs: false,
  });
  const threads = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - sinceDays * 86400 * 1000);
      const uids = await client.search({ since }, { uid: true });
      if (Array.isArray(uids) && uids.length) {
        const pick = uids.slice(-max); // newest UIDs
        for await (const msg of client.fetch(pick, { envelope: true, flags: true, labels: true }, { uid: true })) {
          const from = msg.envelope && msg.envelope.from && msg.envelope.from[0];
          const labels = msg.labels ? Array.from(msg.labels) : [];
          const addr = (from && from.address) || '';
          const actionNeeded =
            labels.some(l => ACTION_LABELS.includes(l)) ||
            HIGH_VALUE.some(d => addr.toLowerCase().includes(d));
          threads.push({
            subject: (msg.envelope && msg.envelope.subject) || '(no subject)',
            fromName: (from && from.name) || addr,
            from: addr,
            date: msg.envelope && msg.envelope.date,
            unread: !(msg.flags && msg.flags.has('\\Seen')),
            actionNeeded,
            // Carried so a reply can be threaded (In-Reply-To/References) and addressed.
            messageId: (msg.envelope && msg.envelope.messageId) || null,
            uid: msg.uid,
          });
        }
      }
    } finally { lock.release(); }
  } catch (e) {
    return { ok: false, error: e.message, threads: [] };
  } finally {
    try { await client.logout(); } catch (e) { /* ignore */ }
  }
  threads.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { ok: true, threads };
}

module.exports = { recentInbox };
