require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
// Stash the raw body alongside the parsed JSON so the Slack events endpoint can
// verify request signatures (Slack signs the raw bytes, not the parsed object).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const authRoutes = require('./routes/auth');
const locationsRoutes = require('./routes/locations');
const targetsRoutes = require('./routes/targets');
const usersRoutes = require('./routes/users');
const metricsRoutes = require('./routes/metrics');
const techEfficiencyRoutes = require('./routes/techEfficiency');
const techniciansRoutes = require('./routes/technicians');
const shopmonkeySyncRoutes = require('./routes/shopmonkeySync');
const hoursSyncRoutes = require('./routes/hoursSync');
const displayRoutes = require('./routes/display');
const financeRoutes = require('./routes/finance');
const marketingCallsRoutes = require('./routes/marketingCalls');
const marketingPostsRoutes = require('./routes/marketingPosts');
const marketingShotsRoutes = require('./routes/marketingShots');
const marketingReviewsRoutes = require('./routes/marketingReviews');
const marketingDriveRoutes = require('./routes/marketingDrive');
const cosRoutes = require('./routes/cos');
const noticesRoutes = require('./routes/notices');
const bonusRoutes = require('./routes/bonus');
const fuelRoutes = require('./routes/fuel');
const timeClockRoutes = require('./routes/timeClock');
const mcpRoutes = require('./routes/mcp');
const { startScheduler } = require('./scheduler');

app.use('/api/auth', authRoutes(pool));
app.use('/api/locations', locationsRoutes(pool));
app.use('/api/targets', targetsRoutes(pool));
app.use('/api/users', usersRoutes(pool));
app.use('/api/metrics', metricsRoutes(pool));
app.use('/api/tech-efficiency', techEfficiencyRoutes(pool));
app.use('/api/technicians', techniciansRoutes(pool));
app.use('/api/sync', shopmonkeySyncRoutes(pool));
app.use('/api/hours', hoursSyncRoutes(pool));
app.use('/api/display', displayRoutes(pool));
app.use('/api/finance', financeRoutes(pool));
app.use('/api/marketing/calls', marketingCallsRoutes(pool));
app.use('/api/marketing/posts', marketingPostsRoutes(pool));
app.use('/api/marketing/shots', marketingShotsRoutes(pool));
app.use('/api/marketing/reviews', marketingReviewsRoutes(pool));
app.use('/api/marketing/drive', marketingDriveRoutes(pool));
app.use('/api/cos', cosRoutes(pool));
app.use('/api/notices', noticesRoutes(pool));
app.use('/api/bonus', bonusRoutes(pool));
app.use('/api/fuel', fuelRoutes(pool));
app.use('/api/clock', timeClockRoutes(pool));
app.use('/api/attention', require('./routes/attention')(pool));
app.use('/mcp', mcpRoutes(pool));
app.use('/report', require('./report')(pool));

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build/index.html'));
  });
}

pool.connect()
  .then(() => console.log('Database connected'))
  .catch(err => console.log('Database connection error:', err.message));

app.listen(PORT, () => {
  console.log(`MJ Lemon Ops Dashboard running on port ${PORT}`);
  startScheduler(pool);
});

module.exports = { pool };
