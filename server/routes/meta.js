const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { holidaysBetween } = require('../lib/workdays');

// Small read-only lookups the client shouldn't duplicate. Holidays come from
// workdays.js — the single 13-province calendar the pay math already uses.
module.exports = () => {
  const router = express.Router();

  router.get('/holidays/:prov', authenticateToken, (req, res) => {
    const prov = String(req.params.prov || 'ab').toLowerCase().slice(0, 2);
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
    const from = isDate(req.query.from) ? req.query.from : today;
    const defaultTo = `${Number(from.slice(0, 4)) + 1}${from.slice(4)}`;
    const to = isDate(req.query.to) && req.query.to <= defaultTo ? req.query.to : defaultTo;
    res.json({ province: prov, from, to, holidays: holidaysBetween(prov, from, to) });
  });

  return router;
};
