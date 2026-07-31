import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insert } from './db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

const MIGRATIONS = [
  { file: 'users.json', table: 'users', transform: u => ({ ...u, researches: JSON.stringify(u.researches || []) }) },
  { file: 'submissions.json', table: 'submissions', transform: s => ({ ...s, statusHistory: JSON.stringify(s.statusHistory || []), files: JSON.stringify(s.files || {}), additionalDocs: JSON.stringify(s.additionalDocs || []), versions: JSON.stringify(s.versions || []), comments: JSON.stringify(s.comments || []) }) },
  { file: 'repository.json', table: 'repository', transform: r => ({ ...r, citation: JSON.stringify(r.citation || {}), fileAvailable: r.fileAvailable ? 1 : 0 }) },
  { file: 'publications.json', table: 'publications', transform: p => ({ ...p, proofDocuments: JSON.stringify(p.proofDocuments || []) }) },
  { file: 'ethics.json', table: 'ethics', transform: e => ({ ...e, statusHistory: JSON.stringify(e.statusHistory || []), files: JSON.stringify(e.files || {}), additionalDocs: JSON.stringify(e.additionalDocs || []), comments: JSON.stringify(e.comments || []), certificate: JSON.stringify(e.certificate || null), compliance: JSON.stringify(e.compliance || null), revisedDocuments: JSON.stringify(e.revisedDocuments || []) }) },
  { file: 'researchers.json', table: 'researchers', transform: r => ({ ...r, completedResearches: JSON.stringify(r.completedResearches || []), publishedWorks: JSON.stringify(r.publishedWorks || []), presentedPapers: JSON.stringify(r.presentedPapers || []), awards: JSON.stringify(r.awards || []), innovationProjects: JSON.stringify(r.innovationProjects || []) }) },
  { file: 'events-module.json', table: 'events_module', transform: e => ({ ...e, gallery: JSON.stringify(e.gallery || []) }) },
  { file: 'event-registrations.json', table: 'event_registrations', transform: r => ({ ...r, certificateData: JSON.stringify(r.certificateData || null) }) },
  { file: 'innovation-extension.json', table: 'innovation_extension', transform: r => ({ ...r, supportingDocuments: JSON.stringify(r.supportingDocuments || []), impactDocuments: JSON.stringify(r.impactDocuments || []) }) },
  { file: 'event-abstracts.json', table: 'event_abstracts', transform: a => ({ ...a }) }
];

async function migrate() {
  for (const m of MIGRATIONS) {
    try {
      const raw = await readFile(join(DATA_DIR, m.file), 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;
      for (const row of data) {
        const transformed = m.transform(row);
        await insert(m.table, transformed);
      }
      console.log(`[seed] Migrated ${data.length} rows into ${m.table}`);
    } catch (err) {
      console.error(`[seed] Skipped ${m.file}:`, err.message);
    }
  }
  console.log('[seed] Done.');
}

migrate();