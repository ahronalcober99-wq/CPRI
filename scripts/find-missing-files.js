import { all } from '../server/server/db/queries.js';
import { supabaseStorage } from '../server/storage/supabase-storage.js';

function manuscriptMetadata(files) {
  let parsed = files;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); }
    catch { return null; }
  }
  return parsed?.manuscript || null;
}

function printMissing(record) {
  const fields = [
    record.id,
    record.title,
    record.authors || record.submitterName || record.fullName || 'Unknown',
    record.status
  ];
  console.log(fields.map(value => JSON.stringify(String(value ?? ''))).join('\t'));
}

async function main() {
  const records = await all(`
    SELECT r.id, r.title, r.authors, r.status, r.fileAvailable,
           s.files, s.submitterName, u.fullName
    FROM repository r
    LEFT JOIN submissions s ON s.id = r.sourceSubmissionId
    LEFT JOIN users u ON u.id = s.submitterId
    ORDER BY r.createdAt DESC
  `);

  console.log('id\ttitle\tauthor\tstatus');
  for (const record of records) {
    const manuscript = manuscriptMetadata(record.files);
    const storagePath = manuscript?.storage_path;
    if (!storagePath) {
      if (manuscript || record.fileAvailable) printMissing(record);
      continue;
    }
    if (!await supabaseStorage.objectExists(storagePath)) printMissing(record);
  }
}

main().catch(error => {
  console.error('[find-missing-files] failed:', error.message);
  process.exitCode = 1;
});
