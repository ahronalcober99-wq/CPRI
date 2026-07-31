# TODO — Slow down "Research" navbar dropdown animation

## Goal
Make the "Research" dropdown submenu (Student Researcher Portal, Submissions, Repository, etc.)
open/close noticeably slower and smoother — target ~500ms with a smooth easing — without changing
its direction, visual appearance, or easing style otherwise.

## Steps
- [x] Analyze task & identify dropdown mechanism (CSS `.cpri-submenu` + JS `.cpri-group.open` toggle)
- [x] Read `public/assets/js/main.js` (nav injection + `initNav` toggle logic)
- [x] Read `public/assets/css/styles.css` (`.cpri-submenu` transition rules)
- [x] Present plan & get user approval
- [x] Edit `public/assets/css/styles.css` (lines ~402–411):
  - Replaced `display: none` hide mechanism with `visibility`/`opacity` so the CSS transition actually animates
  - Set transition to `opacity .5s cubic-bezier(.4,0,.2,1), transform .5s cubic-bezier(.4,0,.2,1), visibility .5s cubic-bezier(.4,0,.2,1)`
  - Kept the `.cols-2` (2-column) Research menu rendering via `display: grid`
  - Kept `translateY(8px)` slide start, position, colors, radius, shadow unchanged
- [ ] Verify in browser: open `student-researchers.html`, hover "Research" — dropdown fades/slides over ~500ms

