// Post to Slack via an incoming webhook URL (COS_SLACK_WEBHOOK). Plain-text
// (mrkdwn) messages; Slack renders *bold*, bullets, and line breaks.
async function postSlack(webhook, text) {
  if (!webhook) return { ok: false, error: 'COS_SLACK_WEBHOOK not set' };
  if (!text) return { ok: false, error: 'no text' };
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mrkdwn: true }),
    });
    if (!res.ok) return { ok: false, error: `slack ${res.status}: ${(await res.text()).slice(0, 120)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { postSlack };
