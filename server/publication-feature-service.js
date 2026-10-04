import { withTransaction } from './server/db/queries.js';

const FEATURED_LIMIT = 6;

function featureValue(value) {
  return value === true || value === 1;
}

function isPublished(value) {
  return String(value || '').toLowerCase() === 'published';
}

function insertSql(record) {
  const columns = Object.keys(record);
  const columnList = columns.map(column => `\`${column}\``).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO publications (${columnList}) VALUES (${placeholders})`,
    values: columns.map(column => record[column])
  };
}

function updateSql(id, changes) {
  const columns = Object.keys(changes);
  const assignments = columns.map(column => `\`${column}\` = ?`).join(', ');
  return {
    sql: `UPDATE publications SET ${assignments} WHERE id = ?`,
    values: [...columns.map(column => changes[column]), id]
  };
}

export function createPublicationFeatureService({ withTransaction: transact = withTransaction }) {
  return {
    async create(record) {
      return transact(async tx => {
        // This locking read holds locks on the InnoDB publication rows until commit.
        // Every feature-count writer takes the same locks before counting, serializing
        // capacity checks instead of allowing concurrent transactions to claim one slot.
        await tx.all('SELECT id FROM publications FOR UPDATE');

        const featured = featureValue(record.featured);
        if (featured && !isPublished(record.status)) {
          return { ok: false, reason: 'unpublished' };
        }
        if (featured) {
          const count = await tx.get(
            'SELECT COUNT(*) AS total FROM publications WHERE featured = ?',
            [1]
          );
          if (Number(count?.total) >= FEATURED_LIMIT) {
            return { ok: false, reason: 'limit' };
          }
        }

        const publication = { ...record, featured: featured ? 1 : 0 };
        const query = insertSql(publication);
        await tx.run(query.sql, query.values);
        return { ok: true, publication };
      });
    },

    async update(id, changes) {
      return transact(async tx => {
        await tx.all('SELECT id FROM publications FOR UPDATE');
        const current = await tx.get('SELECT * FROM publications WHERE id = ?', [id]);
        if (!current) return { ok: false, reason: 'not_found' };

        const nextStatus = changes.status === undefined ? current.status : changes.status;
        const explicitlyEnabling = changes.featured !== undefined && featureValue(changes.featured);
        const requestedFeature = changes.featured === undefined
          ? featureValue(current.featured)
          : featureValue(changes.featured);
        const featured = isPublished(nextStatus) && requestedFeature;
        if (explicitlyEnabling && !isPublished(nextStatus)) {
          return { ok: false, reason: 'unpublished' };
        }

        if (featured && !featureValue(current.featured)) {
          const count = await tx.get(
            'SELECT COUNT(*) AS total FROM publications WHERE featured = ? AND id <> ?',
            [1, id]
          );
          if (Number(count?.total) >= FEATURED_LIMIT) {
            return { ok: false, reason: 'limit' };
          }
        }

        const update = { ...changes, featured: featured ? 1 : 0 };
        const query = updateSql(id, update);
        await tx.run(query.sql, query.values);
        return {
          ok: true,
          publication: { ...current, ...update, id }
        };
      });
    }
  };
}
