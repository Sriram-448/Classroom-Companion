require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { initializeDatabase } = require('./models/database');
const teacherRoutes = require('./routes/teacher-routes');
const studentRoutes = require('./routes/student-routes');
const coordinatorRoutes = require('./routes/coordinator-routes');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000','http://127.0.0.1:5500','http://localhost:5500','null'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('dev'));

app.use('/api/teacher', teacherRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/coordinator', coordinatorRoutes);

// Expose static HTML frontend assets
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/health', (req, res) => res.json({ status:'ok', timestamp:new Date().toISOString() }));


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error:'Internal server error', details: process.env.NODE_ENV==='development' ? err.message : undefined });
});

async function start() {
  try {
    await initializeDatabase();
    console.log('Database ready');

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`\n🔗 Dashboards ready to launch:`);
      console.log(`👉 Coordinator: http://localhost:${PORT}/coordinator/index.html?user=mehta`);
      console.log(`👉 Teacher:     http://localhost:${PORT}/teacher/index.html?user=sharma`);
      console.log(`👉 Student:     http://localhost:${PORT}/student/index.html?user=rahul\n`);
    });

    const { initBot } = require('./services/bot');
    initBot();

    const { startScheduler } = require('./jobs/scheduler');
    startScheduler();

    console.log('Classroom Companion ready!');
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
module.exports = app;