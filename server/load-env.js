import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

if (process.env.NODE_ENV !== 'production') {
  const { config } = await import('dotenv');
  config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
}
