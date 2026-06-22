// Mounts/updates the persistent NAV/WRITING mode badge on document.body.
// Fixed-position so it lives outside the re-rendered sidebar/main-pane subtree
// and survives the 2s poll. Idempotent — safe to call on every render tick.

const BADGE_ID = 'keynav-mode-badge';

export function assertBadge(mode) {
  let el = document.getElementById(BADGE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = BADGE_ID;
    el.className = 'keynav-badge';
    document.body.appendChild(el);
  }
  el.textContent = mode;
  el.dataset.mode = mode;
}

export function removeBadge() {
  const el = document.getElementById(BADGE_ID);
  if (el) el.remove();
}
