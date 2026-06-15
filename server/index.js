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
app.use(express.json());

const authRoutes = require('./routes/auth');
const locationsRoutes = require('./routes/locations');
const targetsRoutes = require('./routes/targets');
const usersRoutes = require('./routes/users');
const metricsRoutes = require('./routes/metrics');
const techEfficiencyRoutes = require('./routes/techEfficiency');

app.use('/api/auth', authRoutes(pool));
app.use('/api/locations', locationsRoutes(pool));
app.use('/api/targets', targetsRoutes(pool));
app.use('/api/users', usersRoutes(pool));
app.use('/api/metrics', metricsRoutes(pool));
app.use('/api/tech-efficiency', techEfficiencyRoutes(pool));

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

app.listen(PORT, () => console.log(`MJ Lemon Ops Dashboard running on port ${PORT}`));

module.exports = { pool };
