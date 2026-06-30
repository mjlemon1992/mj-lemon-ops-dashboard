// Write a reply DRAFT into Gmail via IMAP APPEND — same app password as the
// reader (lib/inbox.js), so no OAuth. Nothing is ever sent: the message lands in
// [Gmail]/Drafts for the owner to open, review, and send himself. This is the
// "Atlas handles the email" action, kept behind the draft-and-approve rule.
const { ImapFlow } = require('imapflow');
const MailComposer = require('nodemailer/lib/mail-composer');

async function draftReply({ user, pass, to, subject, body, inReplyTo, fromName } = {}) {
  if (!user || !pass) return { ok: false, error: 'GMAIL_IMAP_USER / GMAIL_IMAP_PASS not set' };
  if (!to || !body) return { ok: false, error: 'to and body are required' };

  const subj = /^re:/i.test(subject || '') ? subject : `Re: ${(subject || '').trim()}`.trim();
  const headers = {};
  // Thread the draft onto the original so Gmail shows it under the conversation.
  if (inReplyTo) { headers['In-Reply-To'] = inReplyTo; headers['References'] = inReplyTo; }

  const raw = await new Promise((resolve, reject) => {
    new MailComposer({
      from: fromName ? `${fromName} <${user}>` : user,
      to, subject: subj, text: body, headers,
    }).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false, emitLogs: false,
  });
  try {
    await client.connect();
    // Gmail's Drafts is the special-use '[Gmail]/Drafts' mailbox.
    await client.append('[Gmail]/Drafts', raw, ['\\Draft']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { await client.logout(); } catch (_) { /* ignore */ }
  }
}

module.exports = { draftReply };
