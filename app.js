'use strict';

/*
 * GameDock — Modrinth Explorer
 * GitHub Pages-friendly client using Modrinth's public v2 search API.
 * For production use, see README.md for the optional Cloudflare Worker proxy.
 */
const DIRECT_API_BASE = 'https://api.modrinth.com/v2';
// To use the optional Worker, replace DIRECT_API_BASE with its URL, e.g.:
// const DIRECT_API_BASE = 'https://your-worker-name.your-subdomain.workers.dev';
const API_BASE = DIRECT_API_BASE.replace(/\/$/, '');
const PAGE_SIZE = 12;
const STORAGE_KEY = 'gamedock.modrinth.saved.v1';
const STATS_KEY = 'gamedock.practice.sessions.v1';
const PROFILES_KEY = 'gamedock.setup.profiles.v1';
const CHECKLIST_KEY = 'gamedock.checklist.v1';
const DEFAULTS = { query: 'A Fabric performance mod for Minecraft 1.21.10', loader: 'fabric', version: '1.21.10', type: 'mod', sort: 'relevance' };

const els = {
  form: document.querySelector('#search-form'), query: document.querySelector('#search-query'), clearQuery: document.querySelector('#clear-query'),
  loader: document.querySelector('#loader'), version: document.querySelector('#game-version'), anyVersion: document.querySelector('#any-version'), type: document.querySelector('#project-type'), sort: document.querySelector('#sort-by'),
  status: document.querySelector('#status-area'), grid: document.querySelector('#results-grid'), count: document.querySelector('#result-count'), subtitle: document.querySelector('#results-subtitle'),
  loadMoreWrap: document.querySelector('#load-more-wrap'), loadMore: document.querySelector('#load-more'), reset: document.querySelector('#reset-filters'), toast: document.querySelector('#toast')
};

let activeController = null;
let requestNumber = 0;
let currentOffset = 0;
let currentTotal = 0;
let currentResults = [];
let toastTimer = null;

function safeText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? new Intl.NumberFormat(undefined, { notation: number >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number) : '—';
}
function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function getSavedProjects() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => item && typeof item.project_id === 'string') : [];
  } catch (error) {
    console.warn('Could not read saved Modrinth projects:', error);
    return [];
  }
}
function setSavedProjects(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch (error) {
    console.warn('Could not save Modrinth projects:', error);
    showToast('Could not save this project. Your browser storage may be full or disabled.');
    return false;
  }
}
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add('show');
  toastTimer = window.setTimeout(() => els.toast.classList.remove('show'), 2800);
}

// Turn prompts like "A Fabric performance mod for Minecraft 1.21.10" into "performance".
// This is a lightweight keyword helper, not an AI semantic search engine.
function normalizeNaturalLanguage(raw) {
  const original = safeText(raw);
  let value = original.toLowerCase();
  value = value.replace(/\b\d+\.\d+(?:\.\d+)?\b/g, ' ');
  value = value.replace(/\b(fabric|forge|neoforge|neo-forge|quilt|minecraft|mc|mod|mods|modification|modifications|loader|version|versions)\b/g, ' ');
  value = value.replace(/\b(a|an|the|for|on|in|with|that|which|works|working|compatible|support|supports|supported|using|use|find|show|search|look|looking|please|need|want|give|me|my|some|best|good|from|to|of|and|or|it|is|are|i|can|help|helps)\b/g, ' ');
  value = value.replace(/[?!,;:()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  return value || original;
}
function extractVersion(raw) {
  const match = String(raw || '').match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
  return match ? match[1] : '';
}
function extractLoader(raw) {
  const text = String(raw || '').toLowerCase();
  if (/\bneo[- ]?forge\b/.test(text)) return 'neoforge';
  if (/\bfabric\b/.test(text)) return 'fabric';
  if (/\bforge\b/.test(text)) return 'forge';
  if (/\bquilt\b/.test(text)) return 'quilt';
  return '';
}
function selectedVersion() {
  if (els.anyVersion && els.anyVersion.checked) return '';
  return safeText(els.version.value) || extractVersion(els.query.value);
}
function buildSearchURL(offset) {
  const rawQuery = safeText(els.query.value);
  const query = normalizeNaturalLanguage(rawQuery);
  const loader = els.loader.value;
  const version = selectedVersion();
  const projectType = els.type.value;
  const sort = els.sort.value;
  const facets = [];
  if (loader !== 'any' && projectType === 'mod') facets.push([`categories:${loader}`]);
  if (version) facets.push([`versions:${version}`]);
  if (projectType) facets.push([`project_type:${projectType}`]);
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (facets.length) params.set('facets', JSON.stringify(facets));
  params.set('index', sort);
  params.set('offset', String(offset));
  params.set('limit', String(PAGE_SIZE));
  return `${API_BASE}/search?${params.toString()}`;
}
function setLoading(isLoading, isMore = false) {
  const searchButton = els.form.querySelector('button[type="submit"]');
  searchButton.disabled = isLoading;
  searchButton.querySelector('span:first-child').textContent = isLoading ? 'Searching…' : 'Search projects';
  els.loadMore.disabled = isLoading;
  if (isLoading) {
    if (isMore) {
      els.loadMore.querySelector('span').textContent = '…';
    } else {
      els.grid.innerHTML = '';
      els.status.innerHTML = '<div class="loading-indicator"><span class="spinner" aria-hidden="true"></span><div><strong>Searching Modrinth…</strong><p>Fetching live projects and checking your selected compatibility filters.</p></div></div>';
      els.loadMoreWrap.hidden = true;
      els.count.textContent = '…';
    }
  } else {
    els.loadMore.querySelector('span').textContent = '↓';
  }
}
function showNotice(kind, title, message, canRetry = false) {
  const icon = kind === 'error' ? '!' : kind === 'empty' ? '⌕' : 'i';
  els.status.innerHTML = `<div class="notice-card ${kind === 'error' ? 'error' : ''}"><div class="notice-icon" aria-hidden="true">${icon}</div><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(message)}</p>${canRetry ? '<button class="retry-button" id="retry-search" type="button">Try again</button>' : ''}</div></div>`;
  const retry = document.querySelector('#retry-search');
  if (retry) retry.addEventListener('click', () => runSearch({ append: false }));
}
function makePill(label, cls = '') { return `<span class="pill ${cls}">${escapeHTML(label)}</span>`; }
function projectURL(project) {
  // Prefer the stable project slug when present; otherwise use the project ID.
  const identifier = safeText(project.slug) || safeText(project.project_id);
  return `https://modrinth.com/${encodeURIComponent(safeText(project.project_type, 'mod'))}/${encodeURIComponent(identifier)}`;
}
function renderProject(project) {
  const title = safeText(project.title, 'Untitled project');
  const author = safeText(project.author, 'Unknown author');
  const description = safeText(project.description, 'No description provided by the project.');
  const url = projectURL(project);
  const icon = safeText(project.icon_url);
  const loader = els.loader.value;
  const targetVersion = selectedVersion();
  const versions = Array.isArray(project.versions) ? project.versions : [];
  const categories = Array.isArray(project.categories) ? project.categories : [];
  const targetCompatible = targetVersion ? versions.includes(targetVersion) : false;
  const loaderCompatible = loader === 'any' ? false : categories.includes(loader);
  const saved = getSavedProjects().some(item => item.project_id === project.project_id);
  const versionShown = targetVersion ? makePill(`${targetVersion} ${targetCompatible ? '✓' : '?'}`, targetCompatible ? 'good' : 'warn') : '';
  const loaderShown = loader === 'any' ? '' : makePill(`${loader[0].toUpperCase()}${loader.slice(1)} ${loaderCompatible ? '✓' : '?'}`, loaderCompatible ? 'good' : 'warn');
  const otherVersions = versions.filter(version => version !== targetVersion).slice(0, 3);
  const categoryTags = categories.filter(tag => !['fabric', 'forge', 'neoforge', 'quilt'].includes(tag)).slice(0, 3);
  const license = safeText(project.license, 'License not listed');
  const date = formatDate(project.date_modified);
  const iconMarkup = icon
    ? `<img class="project-icon" src="${escapeHTML(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'project-icon project-icon-fallback',textContent:'▦',ariaHidden:'true'}))">`
    : '<div class="project-icon project-icon-fallback" aria-hidden="true">▦</div>';
  return `<article class="project-card">
    <div class="project-head">${iconMarkup}<div class="project-title-block"><a class="project-title" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)}</a><div class="project-author">by ${escapeHTML(author)}</div></div><button class="favorite-button ${saved ? 'saved' : ''}" type="button" data-favorite="${escapeHTML(project.project_id)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove saved project' : 'Save project'}" title="${saved ? 'Remove from saved projects' : 'Save project'}">${saved ? '♥' : '♡'}</button></div>
    <p class="project-description">${escapeHTML(description)}</p>
    <div class="compatibility">${versionShown}${loaderShown}${makePill(escapeHTML(safeText(project.project_type, 'project')),'neutral')}</div>
    <div class="card-meta"><span class="meta-item"><span class="meta-icon" aria-hidden="true">⇩</span>${formatCount(project.downloads)} downloads</span><span class="meta-item"><span class="meta-icon" aria-hidden="true">★</span>${formatCount(project.follows)} followers</span>${date ? `<span class="updated-label">Updated ${escapeHTML(date)}</span>` : ''}</div>
    ${categoryTags.length ? `<div class="card-tags">${categoryTags.map(tag => `<span class="tag">${escapeHTML(tag.replaceAll('_', ' '))}</span>`).join('')}</div>` : ''}
    ${otherVersions.length ? `<div class="card-tags"><span class="project-license">Also lists: ${otherVersions.map(escapeHTML).join(' · ')}${versions.length > otherVersions.length + (targetVersion && versions.includes(targetVersion) ? 1 : 0) ? ' · …' : ''}</span></div>` : ''}
    <div class="project-actions"><span class="project-license" title="${escapeHTML(license)}">${escapeHTML(license)}</span><a class="view-project" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">View on Modrinth <span aria-hidden="true">↗</span></a></div>
  </article>`;
}
function updateResultHeading(total, resultCount) {
  els.count.textContent = Number.isFinite(total) ? formatCount(total) : String(resultCount);
  const query = safeText(els.query.value);
  const normalized = normalizeNaturalLanguage(query);
  const version = selectedVersion();
  const loader = els.loader.value;
  const parts = [];
  if (normalized) parts.push(`“${normalized}”`);
  if (loader !== 'any') parts.push(loader[0].toUpperCase() + loader.slice(1));
  if (version) parts.push(version);
  els.subtitle.textContent = parts.length ? `${parts.join(' · ')}${Number.isFinite(total) ? ` · ${total.toLocaleString()} project${total === 1 ? '' : 's'} found` : ''}` : 'Browse projects from Modrinth.';
}
async function runSearch({ append = false } = {}) {
  if (!safeText(els.query.value)) {
    els.query.focus();
    showNotice('empty', 'Enter a search term', 'Type a mod name or describe what you need, then search again.');
    els.count.textContent = '0';
    els.loadMoreWrap.hidden = true;
    return;
  }
  if (activeController) activeController.abort();
  const controller = new AbortController();
  activeController = controller;
  const thisRequest = ++requestNumber;
  const offset = append ? currentOffset : 0;
  setLoading(true, append);
  try {
    const response = await fetch(buildSearchURL(offset), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit'
    });
    if (!response.ok) {
      const error = new Error(response.status === 429 ? 'Modrinth is rate-limiting requests. Wait a moment and try again.' : `Modrinth returned HTTP ${response.status}. Please try again in a moment.`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.hits) || !Number.isFinite(data.total_hits)) throw new Error('The API returned an unexpected response. Please retry.');
    if (thisRequest !== requestNumber) return;
    currentTotal = data.total_hits;
    currentOffset = offset + data.hits.length;
    if (!append) currentResults = [];
    currentResults = currentResults.concat(data.hits);
    els.status.innerHTML = '';
    els.grid.insertAdjacentHTML(append ? 'beforeend' : 'afterbegin', data.hits.map(renderProject).join(''));
    updateResultHeading(currentTotal, currentResults.length);
    if (!currentTotal || (!append && data.hits.length === 0)) {
      showNotice('empty', 'No matching projects found', 'Try a shorter phrase, remove a filter, or choose another Minecraft version or loader.');
    } else if (data.hits.length === 0 && append) {
      showToast('There are no more projects on this page.');
    }
    els.loadMoreWrap.hidden = !(currentOffset < currentTotal && data.hits.length > 0);
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (thisRequest !== requestNumber) return;
    console.error('Modrinth search failed:', error);
    if (append && currentResults.length) {
      showToast(error.message || 'Could not load more projects.');
      els.loadMoreWrap.hidden = false;
    } else {
      els.grid.innerHTML = '';
      showNotice('error', 'Could not reach Modrinth', `${error.message || 'A network error occurred.'} Check your connection and try again. If this keeps happening on your deployed site, see README.md for the optional API proxy setup.`, true);
      els.count.textContent = '—';
      els.subtitle.textContent = 'Live results are temporarily unavailable.';
      els.loadMoreWrap.hidden = true;
    }
  } finally {
    if (thisRequest === requestNumber) setLoading(false, append);
  }
}

els.form.addEventListener('submit', event => {
  event.preventDefault();
  runSearch({ append: false });
});
els.loadMore.addEventListener('click', () => runSearch({ append: true }));
els.sort.addEventListener('change', () => runSearch({ append: false }));
[els.loader, els.version, els.type].forEach(control => control.addEventListener('change', () => runSearch({ append: false })));
els.clearQuery.addEventListener('click', () => { els.query.value = ''; els.query.focus(); els.grid.innerHTML = ''; els.status.innerHTML = ''; els.count.textContent = '0'; els.subtitle.textContent = 'Enter a mod name or description to search.'; els.loadMoreWrap.hidden = true; });
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => { els.query.value = button.dataset.query || ''; runSearch({ append: false }); }));
els.reset.addEventListener('click', () => {
  els.loader.value = DEFAULTS.loader; els.version.value = DEFAULTS.version; els.anyVersion.checked = false; els.version.disabled = false; els.type.value = DEFAULTS.type; els.sort.value = DEFAULTS.sort; els.query.value = DEFAULTS.query; runSearch({ append: false });
});
els.grid.addEventListener('click', event => {
  const button = event.target.closest('[data-favorite]');
  if (!button) return;
  const projectId = button.dataset.favorite;
  const project = currentResults.find(item => item.project_id === projectId);
  if (!project) return;
  const saved = getSavedProjects();
  const exists = saved.some(item => item.project_id === projectId);
  const next = exists ? saved.filter(item => item.project_id !== projectId) : saved.concat([{
    project_id: project.project_id,
    slug: project.slug || '',
    project_type: project.project_type || 'mod',
    title: project.title || 'Untitled project',
    description: project.description || '',
    icon_url: project.icon_url || '',
    saved_at: new Date().toISOString()
  }]);
  if (setSavedProjects(next)) {
    button.classList.toggle('saved', !exists);
    button.setAttribute('aria-pressed', String(!exists));
    button.setAttribute('aria-label', exists ? 'Save project' : 'Remove saved project');
    button.title = exists ? 'Save project' : 'Remove from saved projects';
    button.textContent = exists ? '♡' : '♥';
    showToast(exists ? 'Removed from your saved projects.' : 'Saved to your browser collection.');
    renderCollection();
    refreshDashboard();
  }
});
// Navigation uses local panels, so the site remains a static GitHub Pages project.
const viewNames = { dashboard: 'Dashboard', 'aim-trainer': 'Aim Trainer', modrinth: 'Modrinth Explorer', collection: 'My Mod Collection', toolbox: 'Gaming Toolbox' };
function showView(name, updateHash = true) {
  if (!viewNames[name]) name = 'dashboard';
  document.querySelectorAll('.view-panel').forEach(panel => { panel.hidden = panel.id !== `view-${name}`; });
  document.querySelectorAll('[data-view]').forEach(link => {
    const active = link.dataset.view === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  const breadcrumb = document.querySelector('#breadcrumb-current');
  if (breadcrumb) breadcrumb.textContent = viewNames[name];
  if (updateHash && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'collection') renderCollection();
  if (name === 'dashboard') refreshDashboard();
  if (name === 'toolbox') { renderChecklist(); renderProfiles(); updateEdpi(); }
  if (name === 'aim-trainer') { resizeAndDrawAim(); updateAimPersonalBest(); }
}
document.querySelectorAll('[data-view]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); showView(link.dataset.view); }));
document.querySelectorAll('[data-open-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.openView)));
window.addEventListener('hashchange', () => showView(location.hash.replace(/^#/, '') || 'dashboard', false));
if (els.anyVersion) {
  const syncAnyVersion = () => { els.version.disabled = els.anyVersion.checked; runSearch({ append: false }); };
  els.anyVersion.addEventListener('change', syncAnyVersion);
}

// Local-only data helpers. Data is never sent to an account or remote server.
function readStoredArray(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch (error) { console.warn(`Could not read ${key}:`, error); return []; }
}
function writeStoredArray(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { console.warn(`Could not write ${key}:`, error); showToast('Could not save data. Browser storage may be full or disabled.'); return false; }
}
function makeId() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }
function fmtNumber(value, decimals = 0) {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: decimals });
}
function getSessions() { return readStoredArray(STATS_KEY).filter(s => s && typeof s.type === 'string'); }
function recordSession(session) {
  const sessions = getSessions();
  sessions.unshift({ id: makeId(), date: new Date().toISOString(), ...session });
  writeStoredArray(STATS_KEY, sessions.slice(0, 300));
  refreshDashboard();
  updateAimPersonalBest();
}
function refreshDashboard() {
  const sessions = getSessions();
  const reactions = sessions.filter(s => s.type === 'reaction' && Number.isFinite(s.reactionMs) && s.reactionMs > 0).map(s => s.reactionMs);
  const flicks = sessions.filter(s => s.type === 'flick' && Number.isFinite(s.score)).map(s => s.score);
  const sessionCount = document.querySelector('#dash-sessions');
  const bestReaction = document.querySelector('#dash-best-reaction');
  const bestAim = document.querySelector('#dash-best-aim');
  const savedMods = document.querySelector('#dash-saved-mods');
  if (sessionCount) sessionCount.textContent = String(sessions.length);
  if (bestReaction) bestReaction.textContent = reactions.length ? `${fmtNumber(Math.min(...reactions))} ms` : '—';
  if (bestAim) bestAim.textContent = flicks.length ? fmtNumber(Math.max(...flicks)) : '—';
  if (savedMods) savedMods.textContent = String(getSavedProjects().length);
  const recent = document.querySelector('#dashboard-recent');
  if (recent) {
    if (!sessions.length) recent.innerHTML = '<p class="muted-copy">Your practice results will appear here after your first round.</p>';
    else recent.innerHTML = sessions.slice(0, 5).map(s => {
      const title = s.type === 'reaction' ? 'Reaction test' : s.type === 'tracking' ? 'Tracking challenge' : 'Flick challenge';
      const result = s.type === 'reaction' ? `${fmtNumber(s.reactionMs)} ms average` : s.type === 'tracking' ? `${fmtNumber(s.accuracy)}% tracking` : `${fmtNumber(s.score)} hits`;
      const date = formatDate(s.date) || 'Just now';
      return `<div class="recent-row"><div><strong>${title}</strong><small>${escapeHTML(date)} · ${fmtNumber(s.accuracy || 0)}% accuracy</small></div><span class="recent-result">${result}</span></div>`;
    }).join('');
  }
}

function projectPageURL(item) {
  const kind = safeText(item.project_type, 'mod');
  const identifier = safeText(item.slug) || safeText(item.project_id);
  return `https://modrinth.com/${encodeURIComponent(kind)}/${encodeURIComponent(identifier)}`;
}
function renderCollection() {
  const grid = document.querySelector('#collection-grid');
  const empty = document.querySelector('#collection-empty');
  const count = document.querySelector('#collection-count');
  if (!grid || !empty || !count) return;
  const projects = getSavedProjects();
  count.textContent = String(projects.length);
  empty.hidden = projects.length > 0;
  grid.innerHTML = projects.map(item => {
    const icon = safeText(item.icon_url);
    const iconMarkup = icon ? `<img class="project-icon" src="${escapeHTML(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="project-icon project-icon-fallback">▦</div>';
    return `<article class="project-card"><div class="project-head">${iconMarkup}<div class="project-title-block"><a class="project-title" href="${escapeHTML(projectPageURL(item))}" target="_blank" rel="noopener noreferrer">${escapeHTML(safeText(item.title, 'Untitled project'))}</a><div class="project-author">Saved project · ${escapeHTML(safeText(item.project_type, 'mod'))}</div></div><button class="favorite-button saved" type="button" data-collection-remove="${escapeHTML(item.project_id)}" aria-label="Remove saved project" title="Remove from collection">♥</button></div><p class="project-description">${escapeHTML(safeText(item.description, 'No description available.'))}</p><div class="project-actions"><span class="project-license">Saved ${escapeHTML(formatDate(item.saved_at) || 'previously')}</span><a class="view-project" href="${escapeHTML(projectPageURL(item))}" target="_blank" rel="noopener noreferrer">View on Modrinth ↗</a></div></article>`;
  }).join('');
}
document.querySelector('#collection-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-collection-remove]');
  if (!button) return;
  const id = button.dataset.collectionRemove;
  const next = getSavedProjects().filter(item => item.project_id !== id);
  if (setSavedProjects(next)) { renderCollection(); refreshDashboard(); showToast('Removed from your collection.'); }
});

// Aim trainer: all modes are rendered locally on a canvas and need no game access.
const aimCanvas = document.querySelector('#aim-canvas');
const aimCtx = aimCanvas ? aimCanvas.getContext('2d') : null;
let aimMode = 'flick', aimRunning = false, aimFrame = 0, aimEndTime = 0, aimStartTime = 0;
let aimHits = 0, aimMisses = 0, trackingFrames = 0, trackingTotalFrames = 0, aimPointer = null;
let aimTarget = { x: 480, y: 240, r: 23 }, aimLastSaved = false;
const AIM_W = 960, AIM_H = 480, AIM_DURATION = 30;
function randomTarget() {
  const r = aimMode === 'tracking' ? 29 : 22;
  return { x: r + 25 + Math.random() * (AIM_W - 2 * (r + 25)), y: r + 20 + Math.random() * (AIM_H - 2 * (r + 20)), r };
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function canvasPoint(event) {
  const rect = aimCanvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * (AIM_W / rect.width), y: (event.clientY - rect.top) * (AIM_H / rect.height) };
}
function currentAimTarget(now) {
  if (aimMode !== 'tracking' || !aimRunning) return aimTarget;
  const elapsed = now - aimStartTime;
  return { x: AIM_W / 2 + Math.sin(elapsed * .00145) * 325, y: AIM_H / 2 + Math.sin(elapsed * .00225) * 135, r: 31 };
}
function drawAimStage(now = performance.now()) {
  if (!aimCtx || !aimCanvas) return;
  const ctx = aimCtx;
  ctx.clearRect(0, 0, AIM_W, AIM_H);
  ctx.fillStyle = '#0d110d'; ctx.fillRect(0, 0, AIM_W, AIM_H);
  ctx.strokeStyle = '#1a2118'; ctx.lineWidth = 1;
  for (let x = 0; x <= AIM_W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, AIM_H); ctx.stroke(); }
  for (let y = 0; y <= AIM_H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(AIM_W, y); ctx.stroke(); }
  const gradient = ctx.createRadialGradient(AIM_W / 2, AIM_H / 2, 10, AIM_W / 2, AIM_H / 2, 410);
  gradient.addColorStop(0, '#172015'); gradient.addColorStop(1, '#0d110d');
  ctx.globalAlpha = .45; ctx.fillStyle = gradient; ctx.fillRect(0, 0, AIM_W, AIM_H); ctx.globalAlpha = 1;
  if (aimMode === 'flick' || aimMode === 'tracking') {
    const t = currentAimTarget(now); aimTarget = t;
    const pulse = aimMode === 'flick' ? Math.sin(now / 130) * 1.8 : 0;
    const r = t.r + pulse;
    ctx.beginPath(); ctx.arc(t.x, t.y, r + 12, 0, Math.PI * 2); ctx.strokeStyle = '#a5f36d55'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, Math.PI * 2); ctx.fillStyle = '#a5f36d'; ctx.fill();
    ctx.beginPath(); ctx.arc(t.x, t.y, r * .68, 0, Math.PI * 2); ctx.fillStyle = '#253d1b'; ctx.fill();
    ctx.beginPath(); ctx.arc(t.x, t.y, r * .27, 0, Math.PI * 2); ctx.fillStyle = '#e8ffd9'; ctx.fill();
    ctx.strokeStyle = '#efffdf'; ctx.globalAlpha = .6; ctx.beginPath(); ctx.moveTo(t.x - r - 5, t.y); ctx.lineTo(t.x + r + 5, t.y); ctx.moveTo(t.x, t.y-r-5); ctx.lineTo(t.x,t.y+r+5); ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (aimMode === 'tracking' && aimRunning) {
    trackingTotalFrames++;
    if (aimPointer && distance(aimPointer, aimTarget) <= aimTarget.r + 5) trackingFrames++;
  }
}
function resizeAndDrawAim() { drawAimStage(); }
function getAimAccuracy() {
  if (aimMode === 'tracking') return trackingTotalFrames ? trackingFrames / trackingTotalFrames * 100 : 0;
  return aimHits + aimMisses ? aimHits / (aimHits + aimMisses) * 100 : 0;
}
function updateAimMetrics(remaining) {
  const scoreEl = document.querySelector('#aim-score');
  const accuracyEl = document.querySelector('#aim-accuracy');
  const timeEl = document.querySelector('#aim-time');
  const stateEl = document.querySelector('#aim-round-state');
  if (scoreEl) scoreEl.textContent = aimMode === 'tracking' ? `${fmtNumber(getAimAccuracy())}%` : String(aimHits);
  if (accuracyEl) accuracyEl.textContent = aimHits + aimMisses + trackingTotalFrames ? `${fmtNumber(getAimAccuracy())}%` : '—';
  if (timeEl) timeEl.textContent = `${Math.max(0, remaining).toFixed(1)}s`;
  if (stateEl) stateEl.textContent = aimRunning ? 'LIVE' : (aimLastSaved ? 'DONE' : 'READY');
}
function bestForMode(mode) {
  const sessions = getSessions().filter(s => s.type === mode);
  if (mode === 'reaction') {
    const times = sessions.filter(s => Number.isFinite(s.reactionMs)).map(s => s.reactionMs);
    return times.length ? `${fmtNumber(Math.min(...times))} ms avg` : '—';
  }
  if (mode === 'tracking') {
    const values = sessions.filter(s => Number.isFinite(s.accuracy)).map(s => s.accuracy);
    return values.length ? `${fmtNumber(Math.max(...values))}% accuracy` : '—';
  }
  const scores = sessions.filter(s => Number.isFinite(s.score)).map(s => s.score);
  return scores.length ? `${fmtNumber(Math.max(...scores))} hits` : '—';
}
function updateAimPersonalBest() {
  const el = document.querySelector('#aim-personal-best');
  if (el) el.textContent = bestForMode(aimMode);
}
function finishAimRound(reason = 'Round complete') {
  if (!aimRunning) return;
  aimRunning = false;
  if (aimFrame) cancelAnimationFrame(aimFrame);
  aimFrame = 0;
  const accuracy = Math.round(getAimAccuracy() * 10) / 10;
  const score = aimMode === 'tracking' ? Math.round(accuracy) : aimHits;
  const sessionType = aimMode;
  recordSession({ type: sessionType, score, accuracy, hits: aimHits, misses: aimMisses, durationSeconds: Math.round((performance.now() - aimStartTime) / 100) / 10 });
  aimLastSaved = true;
  document.querySelector('#aim-start').innerHTML = 'Play again <span>↻</span>';
  document.querySelector('#aim-feedback').textContent = reason;
  document.querySelector('#aim-subfeedback').textContent = sessionType === 'tracking' ? `You tracked the target for ${fmtNumber(accuracy)}% of measured frames.` : `You hit ${aimHits} targets and missed ${aimMisses} clicks.`;
  document.querySelector('#stage-instruction').textContent = 'Round complete — start another when ready.';
  updateAimMetrics(0); updateAimPersonalBest(); drawAimStage();
}
function aimLoop(now) {
  if (!aimRunning) return;
  const left = Math.max(0, (aimEndTime - now) / 1000);
  drawAimStage(now); updateAimMetrics(left);
  if (left <= 0) { finishAimRound('Round complete'); return; }
  aimFrame = requestAnimationFrame(aimLoop);
}
function startAimRound() {
  if (aimRunning) { finishAimRound('Round stopped early'); return; }
  if (aimMode === 'reaction') return;
  aimRunning = true; aimLastSaved = false; aimHits = 0; aimMisses = 0; trackingFrames = 0; trackingTotalFrames = 0; aimPointer = null;
  aimStartTime = performance.now(); aimEndTime = aimStartTime + AIM_DURATION * 1000; aimTarget = randomTarget();
  document.querySelector('#aim-start').textContent = 'Stop round';
  document.querySelector('#aim-feedback').textContent = aimMode === 'flick' ? 'Hit the target. Avoid clicking outside it.' : 'Keep your cursor on the moving target.';
  document.querySelector('#aim-subfeedback').textContent = 'Round in progress — stay focused.';
  document.querySelector('#stage-instruction').textContent = aimMode === 'flick' ? 'Click the bright target. Outside clicks count as misses.' : 'Move your cursor to follow the target.';
  aimFrame = requestAnimationFrame(aimLoop);
}
function renderAimMode(mode) {
  if (aimRunning) finishAimRound('Round stopped early');
  if (typeof resetReactionTest === 'function' && typeof reactionButton !== 'undefined') resetReactionTest();
  aimMode = mode;
  document.querySelectorAll('[data-aim-mode]').forEach(button => {
    const active = button.dataset.aimMode === mode;
    button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active));
  });
  const reaction = mode === 'reaction';
  document.querySelector('#aim-canvas-wrap').hidden = reaction;
  document.querySelector('.aim-stats-grid').hidden = reaction;
  document.querySelector('.aim-controls').hidden = reaction;
  document.querySelector('#reaction-panel').hidden = !reaction;
  const config = {
    flick: ['FLICK CHALLENGE','Hit as many targets as you can.','Click the bright target before the 30-second round ends. Clicking elsewhere counts as a miss.'],
    tracking: ['TRACKING CHALLENGE','Keep your cursor on target.','Follow the moving target for 30 seconds. Your score is the proportion of measured frames spent on target.'],
    reaction: ['REACTION TEST','Measure your response speed.','Wait for the green signal, then click as quickly as you can. Complete five attempts.']
  }[mode];
  document.querySelector('#aim-kicker').textContent = config[0];
  document.querySelector('#aim-title').textContent = config[1];
  document.querySelector('#aim-description').textContent = config[2];
  document.querySelector('#aim-start').innerHTML = 'Start 30-second round <span>↗</span>';
  aimHits = 0; aimMisses = 0; trackingFrames = 0; trackingTotalFrames = 0; aimLastSaved = false;
  updateAimMetrics(AIM_DURATION); updateAimPersonalBest(); drawAimStage();
}
document.querySelectorAll('[data-aim-mode]').forEach(button => button.addEventListener('click', () => renderAimMode(button.dataset.aimMode)));
document.querySelector('#aim-start').addEventListener('click', startAimRound);
if (aimCanvas) {
  aimCanvas.addEventListener('pointerdown', event => {
    if (!aimRunning || aimMode !== 'flick') return;
    const point = canvasPoint(event);
    if (distance(point, aimTarget) <= aimTarget.r + 2) { aimHits++; aimTarget = randomTarget(); }
    else aimMisses++;
    document.querySelector('#aim-score').textContent = String(aimHits);
    document.querySelector('#aim-accuracy').textContent = `${fmtNumber(getAimAccuracy())}%`;
  });
  aimCanvas.addEventListener('pointermove', event => { if (aimRunning && aimMode === 'tracking') aimPointer = canvasPoint(event); });
  aimCanvas.addEventListener('pointerleave', () => { aimPointer = null; });
}

// Reaction tester: five valid reactions, with false starts rejected.
let reactionState = 'idle', reactionTimer = 0, reactionSignalAt = 0, reactionAttempts = 0, reactionTimes = [];
const reactionButton = document.querySelector('#reaction-button');
function resetReactionTest() {
  window.clearTimeout(reactionTimer); reactionState = 'idle'; reactionAttempts = 0; reactionTimes = [];
  reactionButton.className = 'reaction-button'; reactionButton.textContent = 'Start test';
  document.querySelector('#reaction-attempt').textContent = '0 / 5';
  document.querySelector('#reaction-last').textContent = '—'; document.querySelector('#reaction-average').textContent = '—';
  document.querySelector('#reaction-message').textContent = 'Ready when you are.';
}
function startReactionAttempt() {
  window.clearTimeout(reactionTimer); reactionState = 'waiting';
  reactionButton.className = 'reaction-button waiting'; reactionButton.textContent = 'Wait for green…';
  document.querySelector('#reaction-attempt').textContent = `${reactionAttempts + 1} / 5`;
  document.querySelector('#reaction-message').textContent = 'Wait for the button to turn green. Do not click early.';
  reactionTimer = window.setTimeout(() => {
    if (reactionState !== 'waiting') return;
    reactionState = 'go'; reactionSignalAt = performance.now();
    reactionButton.className = 'reaction-button go'; reactionButton.textContent = 'CLICK NOW!';
    document.querySelector('#reaction-message').textContent = 'Now! Click the green button.';
  }, 900 + Math.random() * 2100);
}
reactionButton.addEventListener('click', () => {
  if (reactionState === 'idle') { startReactionAttempt(); return; }
  if (reactionState === 'waiting') {
    window.clearTimeout(reactionTimer); reactionState = 'ready';
    reactionButton.className = 'reaction-button'; reactionButton.textContent = 'Try again';
    document.querySelector('#reaction-message').textContent = 'False start! Wait for green next time, then try again.';
    return;
  }
  if (reactionState === 'go') {
    const ms = Math.round(performance.now() - reactionSignalAt);
    reactionTimes.push(ms); reactionAttempts++; reactionState = reactionAttempts >= 5 ? 'complete' : 'ready';
    reactionButton.className = 'reaction-button';
    document.querySelector('#reaction-attempt').textContent = `${reactionAttempts} / 5`;
    document.querySelector('#reaction-last').textContent = `${ms} ms`;
    const avg = Math.round(reactionTimes.reduce((sum, v) => sum + v, 0) / reactionTimes.length);
    document.querySelector('#reaction-average').textContent = `${avg} ms`;
    if (reactionState === 'complete') {
      reactionButton.textContent = 'Test complete — restart';
      document.querySelector('#reaction-message').textContent = `Finished! Your average was ${avg} ms across five attempts.`;
      recordSession({ type: 'reaction', reactionMs: avg, score: avg, accuracy: 100, attempts: reactionAttempts });
      updateAimPersonalBest();
    } else {
      reactionButton.textContent = 'Next attempt';
      document.querySelector('#reaction-message').textContent = 'Recorded. Click when ready for the next attempt.';
    }
    return;
  }
  if (reactionState === 'ready') { startReactionAttempt(); return; }
  if (reactionState === 'complete') { resetReactionTest(); startReactionAttempt(); }
});

// Sensitivity calculator.
function updateEdpi() {
  const dpi = Number(document.querySelector('#edpi-dpi').value);
  const sens = Number(document.querySelector('#edpi-sens').value);
  const out = document.querySelector('#edpi-result');
  out.textContent = Number.isFinite(dpi) && Number.isFinite(sens) && dpi > 0 && sens > 0 ? fmtNumber(dpi * sens, 3) : 'Check your values';
}
['#edpi-dpi', '#edpi-sens'].forEach(selector => document.querySelector(selector).addEventListener('input', updateEdpi));

// Checklist data and controls.
const DEFAULT_CHECKLIST = [
  { id: 'check-launcher', text: 'Check game updates and launcher', done: false },
  { id: 'check-settings', text: 'Confirm graphics and mouse settings', done: false },
  { id: 'check-ping', text: 'Check connection / close heavy background apps', done: false },
  { id: 'check-warmup', text: 'Complete a short warm-up', done: false }
];
function getChecklist() {
  try {
    const saved = localStorage.getItem(CHECKLIST_KEY);
    if (saved === null) return DEFAULT_CHECKLIST.map(i => ({ ...i }));
    const items = JSON.parse(saved);
    return Array.isArray(items) ? items.filter(i => i && typeof i.text === 'string' && i.id) : DEFAULT_CHECKLIST.map(i => ({ ...i }));
  } catch (error) { console.warn('Could not read checklist:', error); return DEFAULT_CHECKLIST.map(i => ({ ...i })); }
}
function saveChecklist(items) { writeStoredArray(CHECKLIST_KEY, items); }
function renderChecklist() {
  const list = document.querySelector('#checklist-list'); if (!list) return;
  const items = getChecklist();
  list.innerHTML = items.map(item => `<label class="checklist-item ${item.done ? 'done' : ''}"><input type="checkbox" data-check-toggle="${escapeHTML(item.id)}" ${item.done ? 'checked' : ''}><span>${escapeHTML(item.text)}</span><button type="button" class="delete-small" data-check-delete="${escapeHTML(item.id)}" aria-label="Delete ${escapeHTML(item.text)}">×</button></label>`).join('') || '<p class="muted-copy">Your checklist is empty. Add an item above.</p>';
  const done = items.filter(i => i.done).length;
  document.querySelector('#checklist-progress').textContent = `${done} / ${items.length} complete`;
}
document.querySelector('#checklist-form').addEventListener('submit', event => {
  event.preventDefault(); const field = document.querySelector('#checklist-new'); const text = safeText(field.value);
  if (!text) return;
  const items = getChecklist(); items.push({ id: makeId(), text, done: false }); saveChecklist(items); field.value = ''; renderChecklist();
});
document.querySelector('#checklist-list').addEventListener('change', event => {
  const id = event.target.dataset.checkToggle; if (!id) return;
  const items = getChecklist().map(i => i.id === id ? { ...i, done: event.target.checked } : i); saveChecklist(items); renderChecklist();
});
document.querySelector('#checklist-list').addEventListener('click', event => {
  const button = event.target.closest('[data-check-delete]'); if (!button) return;
  event.preventDefault(); const items = getChecklist().filter(i => i.id !== button.dataset.checkDelete); saveChecklist(items); renderChecklist();
});
document.querySelector('#checklist-reset').addEventListener('click', () => { saveChecklist(getChecklist().map(i => ({ ...i, done: false }))); renderChecklist(); showToast('Checklist reset.'); });

// Save and manage game setup profiles.
function getProfiles() { return readStoredArray(PROFILES_KEY).filter(p => p && typeof p.id === 'string' && typeof p.game === 'string'); }
function renderProfiles() {
  const list = document.querySelector('#profile-list'); if (!list) return;
  const profiles = getProfiles();
  list.innerHTML = profiles.length ? `<div class="section-kicker" style="margin-top:18px">SAVED PROFILES · ${profiles.length}</div>` + profiles.map(p => `<article class="profile-card"><div class="profile-card-head"><div><strong>${escapeHTML(p.game)}</strong><p>${escapeHTML(p.resolution || 'Resolution not set')}${p.notes ? ` · ${escapeHTML(p.notes)}` : ''}</p><div class="edpi-line">${fmtNumber(Number(p.dpi) * Number(p.sens), 3)} eDPI · ${fmtNumber(p.dpi)} DPI · Sens. ${escapeHTML(String(p.sens))}</div></div><button type="button" class="delete-small" data-profile-delete="${escapeHTML(p.id)}" aria-label="Delete ${escapeHTML(p.game)} profile">×</button></div></article>`).join('') : '<p class="muted-copy">No setup profiles saved yet.</p>';
}
document.querySelector('#profile-form').addEventListener('submit', event => {
  event.preventDefault();
  const game = safeText(document.querySelector('#profile-game').value);
  const dpi = Number(document.querySelector('#profile-dpi').value), sens = Number(document.querySelector('#profile-sens').value);
  if (!game || !Number.isFinite(dpi) || dpi <= 0 || !Number.isFinite(sens) || sens <= 0) { showToast('Enter a game name, positive DPI and positive sensitivity.'); return; }
  const profiles = getProfiles(); profiles.unshift({ id: makeId(), game, dpi, sens, resolution: safeText(document.querySelector('#profile-resolution').value), notes: safeText(document.querySelector('#profile-notes').value), saved_at: new Date().toISOString() });
  if (writeStoredArray(PROFILES_KEY, profiles)) { document.querySelector('#profile-game').value = ''; document.querySelector('#profile-resolution').value = ''; document.querySelector('#profile-notes').value = ''; renderProfiles(); showToast('Setup saved in this browser.'); }
});
document.querySelector('#profile-list').addEventListener('click', event => {
  const button = event.target.closest('[data-profile-delete]'); if (!button) return;
  writeStoredArray(PROFILES_KEY, getProfiles().filter(p => p.id !== button.dataset.profileDelete)); renderProfiles(); showToast('Setup deleted.');
});

// Export/import a portable backup of GameDock data.
document.querySelector('#export-data').addEventListener('click', () => {
  const backup = { version: 1, exportedAt: new Date().toISOString(), savedProjects: getSavedProjects(), practiceSessions: getSessions(), setupProfiles: getProfiles(), checklist: getChecklist() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'gamedock-backup.json'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); showToast('Backup exported.');
});
document.querySelector('#import-data').addEventListener('change', async event => {
  const file = event.target.files && event.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object') throw new Error('This file is not a GameDock backup.');
    if (!window.confirm('Import this backup? Compatible saved data will be merged, and the current checklist will be replaced.')) { event.target.value = ''; return; }
    if (Array.isArray(data.savedProjects)) {
      const merged = new Map(getSavedProjects().map(p => [p.project_id, p]));
      data.savedProjects.filter(p => p && typeof p.project_id === 'string' && typeof p.title === 'string').forEach(p => merged.set(p.project_id, p));
      setSavedProjects(Array.from(merged.values()));
    }
    if (Array.isArray(data.setupProfiles)) {
      const merged = new Map(getProfiles().map(p => [p.id, p])); data.setupProfiles.filter(p => p && typeof p.game === 'string' && Number(p.dpi) > 0 && Number(p.sens) > 0).forEach(p => { const id = typeof p.id === 'string' && p.id ? p.id : makeId(); merged.set(id, { ...p, id }); }); writeStoredArray(PROFILES_KEY, Array.from(merged.values()));
    }
    if (Array.isArray(data.practiceSessions)) {
      const merged = new Map(getSessions().map(s => [s.id || `${s.type}-${s.date}`, s])); data.practiceSessions.filter(s => s && typeof s.type === 'string').forEach(s => merged.set(s.id || makeId(), { ...s, id: s.id || makeId() })); writeStoredArray(STATS_KEY, Array.from(merged.values()).slice(-300).reverse());
    }
    if (Array.isArray(data.checklist)) saveChecklist(data.checklist.filter(i => i && typeof i.text === 'string').map(i => ({ id: typeof i.id === 'string' ? i.id : makeId(), text: i.text.slice(0,100), done: Boolean(i.done) })));
    renderCollection(); renderProfiles(); renderChecklist(); refreshDashboard(); updateAimPersonalBest(); showToast('Backup imported.');
  } catch (error) { showToast(error.message || 'Could not import this backup file.'); }
  event.target.value = '';
});

// Initialize all panels and support direct GitHub Pages URLs with a hash.
if (els.anyVersion) els.version.disabled = els.anyVersion.checked;
renderChecklist(); renderProfiles(); renderCollection(); refreshDashboard(); updateEdpi(); renderAimMode('flick');
const initialView = location.hash.replace(/^#/, '');
showView(viewNames[initialView] ? initialView : 'dashboard', false);

// On first load, immediately run the example search requested by the user. If the browser cannot reach Modrinth, the UI shows a retryable error.
runSearch({ append: false });
runSearch({ append: false });


// ===== Minecraft coordinate practice =====
(() => {
  const question = document.querySelector('#coord-question');
  if (!question) return;
  const optionsEl = document.querySelector('#coord-options');
  const feedback = document.querySelector('#coord-feedback');
  const nextButton = document.querySelector('#coord-next');
  const roundEl = document.querySelector('#coord-round');
  const scoreEl = document.querySelector('#coord-score');
  let round = 1, score = 0, correctAnswer = '', answered = false;
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  function newRound() {
    answered = false;
    nextButton.disabled = true;
    feedback.textContent = 'Choose an answer.';
    feedback.className = 'feedback-line';
    const axis = pick(['X','Y','Z']);
    const positive = Math.random() < .5;
    const value = Math.floor(Math.random()*180)+20;
    const dir = axis === 'Y' ? (positive ? 'higher up' : 'lower down') : (axis === 'X' ? (positive ? 'east' : 'west') : (positive ? 'south' : 'north'));
    correctAnswer = `${axis} ${positive ? '+' : '-'}${value}`;
    question.textContent = `You are at ${axis} ${positive ? '+' : '-'}${value}. Which direction does that sign point toward?`;
    const directionAnswers = axis === 'Y' ? ['higher up','lower down','east','south'] : axis === 'X' ? ['east','west','higher up','north'] : ['south','north','higher up','west'];
    const correctDir = dir;
    const choices = [...new Set([correctDir, ...directionAnswers])].sort(() => Math.random()-.5);
    optionsEl.replaceChildren();
    choices.forEach(choice => {
      const b = document.createElement('button'); b.type='button'; b.className='choice-button'; b.textContent=choice;
      b.addEventListener('click', () => {
        if (answered) return; answered = true;
        [...optionsEl.children].forEach(x => { x.disabled=true; if (x.textContent===correctDir) x.classList.add('correct'); });
        if (choice === correctDir) { score++; feedback.textContent = 'Correct! ' + correctAnswer + ' points ' + correctDir + '.'; feedback.classList.add('success'); }
        else { b.classList.add('incorrect'); feedback.textContent = `Not quite. ${correctAnswer} points ${correctDir}.`; feedback.classList.add('error'); }
        scoreEl.textContent = score; nextButton.disabled = false;
      });
      optionsEl.appendChild(b);
    });
    roundEl.textContent = round;
  }
  nextButton.addEventListener('click', () => { round++; newRound(); });
  newRound();
})();

// ===== Minecraft mixed quiz =====
(() => {
  const questionEl = document.querySelector('#quiz-question');
  if (!questionEl) return;
  const questions = [
    {q:'Which tool is best for mining stone quickly?',c:'Tools',options:['Pickaxe','Shovel','Hoe','Shears'],a:'Pickaxe'},
    {q:'Which material is needed to craft a torch?',c:'Crafting',options:['Coal or charcoal','Iron ingot','Redstone dust','Clay ball'],a:'Coal or charcoal'},
    {q:'Which mob explodes when it gets close to a player?',c:'Mobs',options:['Creeper','Cow','Villager','Allay'],a:'Creeper'},
    {q:'What does a bed set in the Overworld?',c:'Mechanics',options:['Your respawn point','Your world seed','Your spawn chunks','Your difficulty'],a:'Your respawn point'},
    {q:'Which ore is commonly used to craft a compass?',c:'Crafting',options:['Iron ingots','Diamonds','Emeralds','Copper ingots'],a:'Iron ingots'},
    {q:'Which dimension contains Nether fortresses?',c:'Dimensions',options:['The Nether','The End','The Overworld','The Deep Dark'],a:'The Nether'},
    {q:'What do you need to tame a wolf?',c:'Mobs',options:['Bones','Wheat','Carrots','Seeds'],a:'Bones'},
    {q:'Which block can store items in a basic inventory container?',c:'Blocks',options:['Chest','Furnace','Crafting table','Loom'],a:'Chest'},
    {q:'Which item is used to make a map?',c:'Crafting',options:['Paper and a compass','A book and quill','Iron and sticks','A clock and paper'],a:'Paper and a compass'},
    {q:'What happens if you fall into the void in The End?',c:'Mechanics',options:['You fall endlessly and eventually die','You teleport to the Overworld','You get levitation','Nothing happens'],a:'You fall endlessly and eventually die'}
  ];
  const optionsEl = document.querySelector('#quiz-options'), feedback = document.querySelector('#quiz-feedback');
  const next = document.querySelector('#quiz-next'), restart = document.querySelector('#quiz-restart');
  const number = document.querySelector('#quiz-number'), total = document.querySelector('#quiz-total');
  const category = document.querySelector('#quiz-category'), scoreEl = document.querySelector('#quiz-score'), totalScore = document.querySelector('#quiz-total-score');
  let list=[], index=0, score=0, answered=false;
  function start() { list=[...questions].sort(()=>Math.random()-.5).slice(0,8); index=0; score=0; scoreEl.textContent=score; total.textContent=list.length; totalScore.textContent=list.length; render(); }
  function render() {
    answered=false; next.disabled=true;
    const item=list[index]; number.textContent=index+1; questionEl.textContent=item.q; category.textContent=item.c;
    feedback.textContent='Choose an answer.'; feedback.className='feedback-line'; optionsEl.replaceChildren();
    [...item.options].sort(()=>Math.random()-.5).forEach(choice=>{
      const b=document.createElement('button'); b.type='button'; b.className='choice-button'; b.textContent=choice;
      b.addEventListener('click',()=>{
        if(answered)return; answered=true;
        [...optionsEl.children].forEach(x=>{x.disabled=true;if(x.textContent===item.a)x.classList.add('correct');});
        if(choice===item.a){score++;feedback.textContent='Correct! Nice one.';feedback.classList.add('success');}
        else {b.classList.add('incorrect');feedback.textContent=`Not quite — the answer is ${item.a}.`;feedback.classList.add('error');}
        scoreEl.textContent=score;next.disabled=false;next.textContent=index===list.length-1?'See results ↗':'Next question ↗';
      });
      optionsEl.appendChild(b);
    });
  }
  next.addEventListener('click',()=>{if(index<list.length-1){index++;render();}else{questionEl.textContent=`Quiz complete — you scored ${score} / ${list.length}!`;category.textContent='RESULTS';optionsEl.replaceChildren();feedback.textContent=score>=6?'Great work! Run it again to improve your score.':'Good practice — try another round to learn more.';feedback.className='feedback-line '+(score>=6?'success':'');next.disabled=true;next.textContent='Quiz complete';}});
  restart.addEventListener('click',()=>{next.textContent='Next question ↗';start();});
  start();
})();

// ===== Mod project ZIP preflight (does not compile a JAR) =====
(() => {
  const input=document.querySelector('#mod-project-file'), status=document.querySelector('#mod-project-status');
  if(!input)return;
  input.addEventListener('change',()=>{
    const file=input.files && input.files[0];
    if(!file){status.textContent='No project selected.';return;}
    if(!file.name.toLowerCase().endsWith('.zip')){status.textContent='Please choose a .zip project archive.';status.className='feedback-line error';return;}
    status.className='feedback-line';
    status.textContent=`Selected ${file.name} (${(file.size/1024/1024).toFixed(2)} MB). This browser prototype has not uploaded or compiled it.`;
  });
})();

// Register the additional page names with the existing navigation system.
if (typeof viewNames !== 'undefined') {
  viewNames.coordinates = 'Coordinate Practice';
  viewNames['minecraft-quiz'] = 'Minecraft Quiz';
  viewNames['mod-builder'] = 'Mod Builder';
}

// GameDock GameVerse refresh: global quick search for visible navigation/tools.
(() => {
  const input = document.querySelector('#global-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('.nav-item').forEach(item => {
      item.style.display = !q || item.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
    document.querySelectorAll('.tool-tile').forEach(tile => {
      tile.style.display = !q || tile.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
    if (q && document.querySelectorAll('.tool-tile[style*="display: none"]').length === document.querySelectorAll('.tool-tile').length) {
      // Keep the search field usable; it filters only dashboard quick-access tiles and navigation.
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { input.value = ''; input.dispatchEvent(new Event('input')); input.blur(); }
    if (event.key === 'Enter') {
      const first = [...document.querySelectorAll('.nav-item')].find(item => item.style.display !== 'none' && item.getAttribute('data-view'));
      if (first) first.click();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) {
      event.preventDefault(); input.focus();
    }
  });
})();


// Fabric Mod Converter: safe, local ZIP inspection only (not a converter/build service).
document.addEventListener('DOMContentLoaded', () => {
  const input = document.querySelector('#fabric-converter-file');
  const status = document.querySelector('#fabric-converter-status');
  const report = document.querySelector('#fabric-converter-report');
  if (!input || !status || !report) return;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    report.hidden = true;
    report.textContent = '';
    if (!file) { status.textContent = 'No file selected.'; return; }
    if (!/\.zip$/i.test(file.name) || file.size > 50 * 1024 * 1024) {
      status.textContent = 'Choose a ZIP file smaller than 50 MB.';
      return;
    }
    if (!window.JSZip) {
      status.textContent = 'ZIP inspection library did not load. Check your internet connection and try again.';
      return;
    }
    status.textContent = 'Inspecting ZIP locally…';
    try {
      const archive = await window.JSZip.loadAsync(file, { checkCRC32: false });
      const paths = Object.keys(archive.files).filter(p => !archive.files[p].dir);
      if (paths.length > 10000) throw new Error('This archive contains too many entries to inspect safely.');
      const lower = paths.map(p => p.toLowerCase());
      const find = suffix => lower.some(p => p.endsWith(suffix));
      const fabricMeta = find('fabric.mod.json');
      const forgeMeta = find('meta-inf/mods.toml') || find('mcmod.info');
      const gradle = find('build.gradle') || find('build.gradle.kts') || find('gradlew');
      const source = lower.some(p => /(^|\/)src\/main\/java\//.test(p) || /(^|\/)src\/main\/kotlin\//.test(p));
      const jars = paths.filter(p => /\.jar$/i.test(p));
      const assets = lower.some(p => p.includes('assets/')) || lower.some(p => p.endsWith('pack.mcmeta'));
      const summary = document.createElement('div');
      const heading = document.createElement('h3');
      heading.textContent = 'Inspection report';
      summary.appendChild(heading);
      const list = document.createElement('ul');
      const lines = [
        `Archive: ${file.name}`,
        `Files found: ${paths.length}`,
        `Fabric metadata: ${fabricMeta ? 'found' : 'not found'}`,
        `Forge metadata: ${forgeMeta ? 'found' : 'not found'}`,
        `Gradle build files: ${gradle ? 'found' : 'not found'}`,
        `Java/Kotlin source paths: ${source ? 'found' : 'not found'}`,
        `JAR files inside ZIP: ${jars.length}`,
        `Resource-pack indicators: ${assets ? 'found' : 'not found'}`
      ];
      lines.forEach(line => { const li = document.createElement('li'); li.textContent = line; list.appendChild(li); });
      summary.appendChild(list);
      const conclusion = document.createElement('p');
      conclusion.className = 'muted-copy';
      if (fabricMeta) conclusion.textContent = 'This archive appears to contain Fabric metadata. It may already be a Fabric project or mod; inspect its files and version requirements before rebuilding.';
      else if (forgeMeta && source && gradle) conclusion.textContent = 'This looks like a Forge source project. A Fabric port may be possible, but its code and Forge-specific APIs need manual changes before a Fabric build.';
      else if (jars.length && !source) conclusion.textContent = 'This archive appears to contain compiled JAR files but no obvious source. Automatic conversion to Fabric is generally not possible from compiled files alone.';
      else if (source && gradle) conclusion.textContent = 'This looks like a source project. Its loader and dependencies need review; a successful Fabric build requires compatible code and configuration.';
      else if (assets) conclusion.textContent = 'This may be a resource pack or assets archive rather than a standalone mod. Assets alone cannot be compiled into a Fabric mod.';
      else conclusion.textContent = 'The ZIP type is unclear. Review its contents manually; this inspector cannot guarantee compatibility or safety.';
      summary.appendChild(conclusion);
      report.appendChild(summary);
      report.hidden = false;
      status.textContent = 'Inspection complete. Your ZIP was inspected in this browser and was not uploaded.';
    } catch (err) {
      status.textContent = 'Could not inspect this ZIP: ' + (err && err.message ? err.message : 'unknown error');
    }
  });
});
