/* ============================================================
   CPRI — Research Gala: pieces shared by the form, the details page,
   the presenter dashboard, My Account and the Admin Console.

     GalaUI.esc(text)
     GalaUI.pill(status, label)
     GalaUI.tracker(submission)       status tracker (HTML string)
     GalaUI.scheduleBlock(submission) date / time / room once announced
     GalaUI.notes(submission)         admin remarks + "action needed" notice
     GalaUI.timeline(submission)      status history
     GalaUI.fmtDate(iso) / fmtWhen(iso)

   Every value that reaches innerHTML goes through esc().
   ============================================================ */
(function () {
  'use strict';

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  var LABELS = {
    draft: 'Draft', submitted: 'Submitted', under_checking: 'Under Checking', for_revision: 'For Revision',
    scheduled: 'Scheduled', presented: 'Presented', rejected: 'Rejected'
  };

  function pill(status, label) {
    return '<span class="gala-pill" data-status="' + esc(status) + '">' + esc(label || LABELS[status] || status) + '</span>';
  }

  // The path a healthy entry takes. For Revision is a detour at step 2 and
  // Rejected an exit, so neither gets a column of its own until it happens.
  var MAIN = [
    ['submitted', 'Submitted'],
    ['under_checking', 'Under Checking'],
    ['scheduled', 'Scheduled'],
    ['presented', 'Presented']
  ];
  var POSITION = { submitted: 0, under_checking: 1, for_revision: 1, scheduled: 2, presented: 3 };

  function furthestReached(sub) {
    if (sub.status !== 'rejected') return POSITION[sub.status] != null ? POSITION[sub.status] : 0;
    var best = 0;
    (sub.statusHistory || []).forEach(function (h) {
      if (h.kind === 'update') return;
      if (POSITION[h.status] != null) best = Math.max(best, POSITION[h.status]);
    });
    return best;
  }

  function whenReached(sub, status) {
    var entry = (sub.statusHistory || []).find(function (h) { return h.kind !== 'update' && h.status === status; });
    return entry ? fmtDate(entry.at) : '';
  }

  function tracker(sub) {
    if (sub.status === 'draft') {
      return '<p class="form-note" style="margin:10px 0;">This entry is a draft. It has not been submitted yet, so there is nothing to track.</p>';
    }
    var reached = furthestReached(sub);
    var rejected = sub.status === 'rejected';
    var cols = MAIN.length + (rejected ? 1 : 0);

    var items = MAIN.map(function (step, i) {
      var cls = '';
      var dot = String(i + 1);
      var label = step[1];
      var sub2 = whenReached(sub, step[0]);
      if (i < reached || (i === reached && (rejected || sub.status === 'presented'))) {
        cls = 'is-done'; dot = '&#10003;';
      } else if (i === reached) {
        if (sub.status === 'for_revision') {
          cls = 'is-revision'; dot = '!'; label = 'For Revision';
          sub2 = whenReached(sub, 'for_revision') || sub2;
        } else {
          cls = 'is-current';
        }
      }
      return '<li class="' + cls + '"' + (cls === 'is-current' || cls === 'is-revision' ? ' aria-current="step"' : '') + '>' +
        '<span class="gt-dot" aria-hidden="true">' + dot + '</span>' +
        '<span><span class="gt-label">' + esc(label) + '</span>' +
        (sub2 ? '<br><span class="gt-sub">' + esc(sub2) + '</span>' : '') + '</span></li>';
    });

    if (rejected) {
      items.push('<li class="is-rejected" aria-current="step"><span class="gt-dot" aria-hidden="true">&times;</span>' +
        '<span><span class="gt-label">Rejected</span>' +
        (whenReached(sub, 'rejected') ? '<br><span class="gt-sub">' + esc(whenReached(sub, 'rejected')) + '</span>' : '') + '</span></li>');
    }
    return '<ol class="gala-tracker" style="--gt-cols:' + cols + '" aria-label="Submission progress: ' + esc(sub.statusLabel || sub.status) + '">' +
      items.join('') + '</ol>';
  }

  // Shown to the presenter only once the schedule is announced; the server
  // sends `schedule: null` until then, so this simply renders what it is given.
  function scheduleBlock(sub) {
    if (!sub.schedule) {
      if (sub.status === 'submitted' || sub.status === 'under_checking' || sub.status === 'for_revision') {
        return '<p class="form-note" style="margin:10px 0;">Your presentation schedule will appear here when the organizers announce it' +
          (sub.schedulePreferenceLabel && sub.schedulePreference !== 'none' ? ' (your preference: ' + esc(sub.schedulePreferenceLabel) + ')' : '') + '.</p>';
      }
      if (sub.status === 'scheduled') {
        return '<p class="form-note" style="margin:10px 0;">Your date, time and room are to be announced.</p>';
      }
      return '';
    }
    var s = sub.schedule;
    return '<div class="gala-schedule" role="group" aria-label="Presentation schedule">' +
      '<div><b>Date</b><span>' + esc(s.dateLabel) + '</span></div>' +
      '<div><b>Time</b><span>' + esc(s.timeLabel) + '</span></div>' +
      '<div><b>Room</b><span>' + esc(s.room) + '</span></div>' +
      '<div><b>Format</b><span>' + esc(sub.presentationTypeLabel) + '</span></div></div>';
  }

  function notes(sub) {
    var out = '';
    if (sub.status === 'for_revision') {
      out += '<div class="gala-note is-action" role="status"><b>Action needed: revise and resubmit</b>' +
        (sub.remarks ? esc(sub.remarks) : 'The organizers sent this back for revision.') + '</div>';
    } else if (sub.remarks) {
      out += '<div class="gala-note"><b>Remarks from the organizers</b>' + esc(sub.remarks) + '</div>';
    }
    return out;
  }

  function timeline(sub) {
    var items = (sub.statusHistory || []).slice().reverse();
    if (!items.length) return '';
    return '<ul class="gala-timeline">' + items.map(function (h) {
      var title = h.kind === 'update' ? 'Update' : esc(h.label);
      return '<li><div><strong>' + title + '</strong> <span class="gtl-when">' + esc(fmtWhen(h.at)) + (h.by ? ' &middot; ' + esc(h.by) : '') + '</span></div>' +
        (h.note ? '<p class="gtl-note">' + esc(h.note) + '</p>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  window.GalaUI = {
    esc: esc, pill: pill, tracker: tracker, scheduleBlock: scheduleBlock,
    notes: notes, timeline: timeline, fmtDate: fmtDate, fmtWhen: fmtWhen, LABELS: LABELS
  };
})();
