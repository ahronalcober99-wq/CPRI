import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import express from 'express';
import session from 'express-session';
import { authRouter, initAuth } from './auth.js';
import { submissionsRouter } from './submissions.js';
import { repositoryRouter } from './repository.js';
import { publicationsRouter } from './publications.js';
import { ethicsRouter } from './ethics.js';
import { researchersRouter } from './researchers.js';
import { eventsModuleRouter } from './events-module.js';
import { innovationExtensionRouter } from './innovation-extension.js';
import { adminDashboardRouter } from './admin-dashboard.js';
import { adminInsightsRouter } from './admin-insights.js';
import { reportsRouter } from './reports.js';
import { testConnection } from './db.js';
import { insert } from './server/db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, 'data');
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'cpri.sid',
  secret: process.env.SESSION_SECRET || 'cpri-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use('/api/auth', authRouter);
app.use('/api/submissions', submissionsRouter);
app.use('/api/repository', repositoryRouter);
app.use('/api/publications', publicationsRouter);
app.use('/api/ethics', ethicsRouter);
app.use('/api/researchers', researchersRouter);
app.use('/api/events-module', eventsModuleRouter);
app.use('/api/innovation-extension', innovationExtensionRouter);
app.use('/api/admin', adminDashboardRouter);
app.use('/api/admin', adminInsightsRouter);
app.use('/api/reports', reportsRouter);

app.use(express.static(PUBLIC_DIR));

// Content APIs (switch from readJson to SQL)
app.get('/api/site', async (req, res) => {
  const row = await fs.readFile(join(DATA_DIR, 'profile.json'), 'utf8').catch(() => '{}');
  res.json(JSON.parse(row));
});

app.get('/api/announcements', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'announcements.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items).sort((a, b) => new Date(b.date) - new Date(a.date)));
});

app.get('/api/events', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'events.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items).sort((a, b) => new Date(a.date) - new Date(b.date)));
});

app.get('/api/research', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'research.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items));
});

app.get('/api/agenda', async (req, res) => {
  const items = await fs.readFile(join(DATA_DIR, 'agenda.json'), 'utf8').catch(() => '[]');
  res.json(JSON.parse(items));
});

app.post('/api/contact', async (req, res) => {
  const { name, email, subject, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  try {
    await insert('inquiries', {
      name: String(name).trim(),
      email: String(email).trim(),
      subject: subject ? String(subject).trim() : '',
      message: String(message).trim(),
      receivedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Could not persist inquiry:', err);
  }
  res.status(201).json({ ok: true, message: 'Thank you. Your inquiry has been received.' });
});

app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'index.html'));
});

const server = app.listen(PORT, async () => {
  await testConnection();
  await initAuth();
  console.log(`CPRI public website running at http://localhost:${PORT}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The server may already be running.`);
    console.log(`Try opening http://localhost:${PORT} in your browser.`);
  } else {
    console.error('Server failed to start:', err.message);
  }
  process.exit(1);
});
