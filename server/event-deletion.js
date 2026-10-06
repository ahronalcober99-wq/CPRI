import { basename, join } from 'path';

function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase();
}

export function resolveContentEventPhotoPath(photo, uploadDir) {
  if (typeof photo !== 'string' || !photo.startsWith('/') || photo.startsWith('//')) return null;
  try {
    const pathname = decodeURIComponent(new URL(photo, 'http://localhost').pathname);
    if (!pathname.startsWith('/assets/uploads/events/')) return null;
    const filename = basename(pathname);
    if (!filename || filename === '.' || filename === '..') return null;
    return join(uploadDir, filename);
  } catch {
    return null;
  }
}

export function isValidEventId(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export async function deleteEventAcrossStores(eventId, {
  readContentEvents,
  writeContentEvents,
  withTransaction,
  cleanupFiles
}) {
  const contentEvents = await readContentEvents();
  let contentWasUpdated = false;
  let deleted;

  try {
    deleted = await withTransaction(async tx => {
      const contentEvent = contentEvents.find(event => String(event.id) === String(eventId));
      const moduleEvent = await tx.get(
        'SELECT id, title, photo, imagepublicid AS imagePublicId FROM events_module WHERE id = ? FOR UPDATE',
        [eventId]
      );
      if (!contentEvent && !moduleEvent) return null;

      const titleKey = normalizeTitle(contentEvent?.title || moduleEvent?.title);
      const removedContentEvents = titleKey
        ? contentEvents.filter(event => normalizeTitle(event.title) === titleKey)
        : contentEvent ? [contentEvent] : [];
      const moduleEvents = titleKey
        ? await tx.all(
          'SELECT id, title, photo, imagepublicid AS imagePublicId FROM events_module WHERE LOWER(TRIM(title)) = ? FOR UPDATE',
          [titleKey]
        )
        : moduleEvent ? [moduleEvent] : [];
      const moduleIds = [...new Set([
        ...moduleEvents.map(event => String(event.id)),
        ...(moduleEvent ? [String(moduleEvent.id)] : [])
      ])];

      if (moduleIds.length) {
        const placeholders = moduleIds.map(() => '?').join(', ');
        await tx.run(`DELETE FROM event_registrations WHERE eventId IN (${placeholders})`, moduleIds);
        await tx.run(`DELETE FROM event_abstracts WHERE eventId IN (${placeholders})`, moduleIds);
        await tx.run(`DELETE FROM events_module WHERE id IN (${placeholders})`, moduleIds);
      }

      if (removedContentEvents.length) {
        const removedIds = new Set(removedContentEvents.map(event => String(event.id)));
        await writeContentEvents(contentEvents.filter(event => !removedIds.has(String(event.id))));
        contentWasUpdated = true;
      }

      return {
        id: String(eventId),
        title: contentEvent?.title || moduleEvent?.title || '',
        contentEvents: removedContentEvents,
        moduleEvents
      };
    });
  } catch (error) {
    if (contentWasUpdated) {
      try {
        await writeContentEvents(contentEvents);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Event deletion failed and the content event file could not be restored.');
      }
    }
    throw error;
  }

  if (!deleted) return null;
  const warnings = await cleanupFiles(deleted);
  return { ...deleted, warnings: warnings || [] };
}
