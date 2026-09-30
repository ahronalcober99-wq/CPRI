import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..'); // server/dev -> project root

function envFromDotenv(key) {
  try {
    const txt = readFileSync(join(ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm'));
    if (!m) return '';
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v;
  } catch { return ''; }
}

const id = envFromDotenv('GOOGLE_CLIENT_ID');
console.log('GOOGLE_CLIENT_ID:', id ? `present (len ${id.length})` : 'EMPTY/MISSING');
console.log('starts with digits:', /^\d+-\w+\.apps\.googleusercontent\.com$/.test(id));
