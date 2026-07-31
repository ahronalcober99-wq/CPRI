# TODO — Make Admin "Insights" sidebar items fully functional

## Goal
Wire the 5 Admin sidebar "Insights" items (Analytics & Reports, Audit Logs, Calendar,
Email Notifications, File Manager) to real pages/endpoints with live data, active
sidebar highlighting, and reusable backend endpoints.

## Backend
- [ ] Create `server/admin-insights.js`:
  - [ ] GET /api/admin/analytics (submissions over time, approval rate, category, top programs, top researchers)
  - [ ] GET /api/admin/calendar (submission/ethics/publication/event dates)
  - [ ] GET /api/admin/files (list files across modules + uploads dir)
  - [ ] POST /api/admin/files/upload (multer → uploads/files)
  - [ ] POST /api/admin/files/delete (validated delete)
  - [ ] GET /api/admin/notifications/status (SMTP config flag)
  - [ ] GET /api/admin/notifications/history (email/notification log entries)
  - [ ] GET/PUT /api/admin/notifications/prefs (JSON file persistence)
  - [ ] GET /api/admin/reports/category, /top-programs, /top-researchers
- [ ] Enhance GET /api/admin/logs in `admin-dashboard.js`: add pagination + actor name join
- [ ] Add audit hooks (addLog) in: submissions.js, ethics.js, publications.js, repository.js, events-module.js, innovation-extension.js
- [ ] Mount router in `server.js`

## Frontend
- [ ] admin-dashboard.html — fix Insights sidebar links + active highlighting
- [ ] reports.html — add Chart.js analytics dashboard (keep CSV/Excel/PDF exports)
- [ ] audit-logs.html — user filter + pagination + actor name + total count
- [ ] calendar.html — month-grid calendar of submission/ethics/publication/event dates
- [ ] email-notifications.html — SMTP status banner, server-side prefs, sent-history table
- [ ] file-manager.html — wire to new /api/admin/files endpoints

## Verify
- [ ] node --check all edited server files
- [ ] Start server, confirm endpoints return data
</content>

