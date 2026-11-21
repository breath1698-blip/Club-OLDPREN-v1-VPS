export const root = document.querySelector('#app');
const notice = document.querySelector('#notice');
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const tiers = ['SS', 'S', 'A', 'B', 'C', 'D', 'E', 'F'];
export const page = () => location.hash.slice(1);
export const dateText = date => new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' }).format(new Date(date.length === 10 ? date + 'T12:00:00Z' : date));
export const dateShort = date => new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date(date.length === 10 ? date + 'T12:00:00Z' : date));
export const tierBadge = tier => '<span class="tier-badge tier-' + esc(tier) + '">' + esc(tier) + '</span>';
export function tierCaption(player) {
  if (player.calibration === null) return 'Langsung aktif';
  return player.calibration < 5 ? 'Kalibrasi ' + player.calibration + '/5' : 'Terkalibrasi';
}
export const matchStatus = { active: 'Sedang main', queued: 'Berikutnya', finished: 'Menunggu skor', cancelled: 'Batal', unscored: 'Tanpa skor' };
export const scoreText = score => score ? score.join(' – ') : '–';
export const field = (name, label, attributes) => '<label>' + label + '<input name="' + name + '" ' + attributes + '></label>';
export const button = (label, attributes = '', style = 'button') => '<button class="' + style + '" ' + attributes + '>' + label + '</button>';
export const empty = text => '<p class="empty">' + esc(text) + '</p>';
export const badge = text => '<span class="status">' + esc(text) + '</span>';

export async function api(path, body) {
  const result = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await result.json();
  if (!result.ok) throw Object.assign(new Error(data.error || 'Ada gangguan. Coba lagi.'), { status: result.status });
  return data;
}

let noticeTimer;
export function feedback(message, failed = false) {
  clearTimeout(noticeTimer);
  notice.className = '';
  const target = document.querySelector('dialog[open] .dialog-feedback') ?? notice;
  target.textContent = message;
  target.className = (target === notice ? '' : 'dialog-feedback ') + (failed ? 'visible error' : 'visible');
  noticeTimer = setTimeout(() => { target.className = target === notice ? '' : 'dialog-feedback'; }, failed ? 6500 : 3500);
}

export function layout(contents, navigation = '', brandLink = '/') {
  root.innerHTML = '<a class="skip" href="#konten">Ke konten</a><header class="site-header"><div class="frame header-inner">' +
    '<a class="brand" href="' + esc(brandLink) + '"><img src="/assets/logo.png" alt="" width="43" height="43"><span>Club OLDPREN</span></a>' +
    navigation + '</div></header><main id="konten" class="frame main" tabindex="-1">' + contents + '</main>';
  root.querySelector('.skip').addEventListener('click', event => {
    event.preventDefault();
    document.querySelector('#konten').focus();
  });
}

export function nav(items, selected) {
  return '<nav aria-label="Navigasi utama">' + items.map(([value, title]) =>
    '<a href="#' + value + '"' + (selected === value ? ' aria-current="page"' : '') + '>' + title + '</a>').join('') + '</nav>';
}

export function hero(first, last, description, crest = false) {
  return '<section class="hero"><div><h1>' + first + ' <em>' + last + '</em></h1>' +
    (description ? '<p>' + esc(description) + '</p>' : '') + '</div>' +
    (crest ? '<div class="hero-art" aria-hidden="true"><div class="court-art"><i></i></div><img src="/assets/logo.png" alt=""></div>' : '') +
    '</section>';
}

export function teams(match, { withTier = false, nicknames } = {}) {
  return '<div class="teams">' + match.teams.map((team, index) =>
    '<div class="team"><span>Tim ' + (index ? 'B' : 'A') + '</span>' + team.map(player =>
      '<div>' + (withTier && player.tier ? tierBadge(player.tier) + ' ' : '') + esc(nicknames?.get(player.id) || player.display) + '</div>').join('') + '</div>' +
    (index === 0 ? '<span class="versus">vs</span>' : '')).join('') + '</div>';
}

export function popup(title, contents) {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = '<div class="dialog-head"><h2>' + esc(title) + '</h2><form method="dialog"><button class="quiet close" aria-label="Tutup">×</button></form></div>' +
    '<div class="dialog-feedback" role="status"></div>' + contents;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  return dialog;
}

export async function run(control, fn) {
  if (control?.disabled) return;
  if (control) control.disabled = true;
  try { await fn(); }
  catch (error) { feedback(error.message || 'Ada gangguan. Coba lagi.', true); }
  finally { if (control) control.disabled = false; }
}

export function bindForm(id, handler, scope = document) {
  scope.querySelector('#' + id)?.addEventListener('submit', event => {
    event.preventDefault();
    run(event.submitter, () => handler(new FormData(event.currentTarget)));
  });
}

export function clipboard(id, value) {
  document.getElementById(id)?.addEventListener('click', event => run(event.currentTarget, async () => {
    await navigator.clipboard.writeText(value);
    feedback('Tautan disalin.');
  }));
}
