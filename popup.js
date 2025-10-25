/* global LanguageModel */
/* WebStash – Save, Browse (waterfall), and Inline Chat over the EXACT filtered dataset. */

const el = (id) => document.getElementById(id);

/* ---------- Tabs ---------- */
const tabSave = el('tab-save');
const tabBrowse = el('tab-browse');
const viewSave = el('view-save');
const viewBrowse = el('view-browse');

/* ---------- Save form ---------- */
const addForm = el('add-item-form');
const titleInput = el('item-title');
const contentInput = el('item-content');
const tagsInput = el('item-tags');
const saveStatus = el('save-status');

/* ---------- Browse controls ---------- */
const searchInput = el('search-input');
const orderSelect = el('order-select');
const clearFiltersBtn = el('clear-filters');
const exportBtn = el('export-json');
const results = el('results');

/* ---------- Inline Chat UI ---------- */
const toggleChatBtn = el('toggle-chat');
const chatPanel = el('chat-panel');
const inputPrompt = el('input-prompt');
const buttonPrompt = el('button-prompt');
const buttonReset = el('button-reset');
const elementResponse = el('response');
const responseBody = el('response-body');
const elementLoading = el('loading');
const elementError = el('error');
const sliderTemperature = el('temperature');
const sliderTopK = el('top-k');
const labelTemperature = el('label-temperature');
const labelTopK = el('label-top-k');

/* ---------- State ---------- */
let allItems = [];
let lastFilteredItems = []; // ← what the chat uses
const STORAGE_KEY = 'webstash_items_v1';
let session = null;

/* ---------- Utils ---------- */
function nowISO() { return new Date().toISOString(); }

function normalizeTags(raw) {
  if (!raw) return [];
  const split = raw.split(/[\s,]+/).filter(Boolean);
  return Array.from(new Set(
    split
      .map(t => t.trim())
      .map(t => t.startsWith('#') ? t.slice(1) : t)
      .map(t => t.toLowerCase())
      .filter(t => t.length > 0)
  ));
}
function guessType(s) {
  if (!s) return 'note';
  try {
    const u = new URL(s.trim());
    const path = (u.pathname || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(path)) return 'image';
    if (/\.(mp4|webm|mov|m4v|avi)$/.test(path)) return 'video';
    return 'link';
  } catch { return 'note'; }
}
function containsText(hay, needle) {
  return (hay || '').toLowerCase().includes((needle || '').toLowerCase());
}
function parseSearchQuery(q) {
  const words = (q || '').trim().split(/\s+/).filter(Boolean);
  const tags = words.filter(w => w.startsWith('#')).map(w => w.slice(1).toLowerCase());
  const textTerms = words.filter(w => !w.startsWith('#'));
  return { tags, text: textTerms.join(' ').trim() };
}
function groupByDate(items) {
  const map = new Map();
  for (const it of items) {
    const d = new Date(it.createdAt);
    const today = new Date();
    const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const tt = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = (tt - dt) / 86400000;
    let label = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    if (diff === 0) label = 'Today';
    if (diff === 1) label = 'Yesterday';
    if (!map.has(label)) map.set(label, []);
    map.get(label).push(it);
  }
  return map;
}

/* ---------- Storage ---------- */
async function loadItems() {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  allItems = Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
}
async function saveItems(items) {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

/* ---------- JSONL serializer (for chat) ---------- */
function itemsToJSONL(items, { maxItems = 200, maxContent = 400 } = {}) {
  return items.slice(0, maxItems).map(it => {
    const snippet = (it.content || '').slice(0, maxContent);
    return JSON.stringify({
      id: it.id,
      title: it.title || '',
      tags: it.tags || [],
      content: snippet,
      createdAt: it.createdAt,
      type: it.type || 'note'
    });
  }).join('\n');
}

/* ---------- Build grounded prompt from JSONL (no extra filtering) ---------- */
function buildGroundedPromptFromJSONL(jsonl, userQuestion) {
  return (
`You are given the user's currently filtered WebStash items as JSON Lines (one JSON object per line).
Each object has: id, title, tags[], content (snippet), createdAt, type.

Use ONLY this dataset to answer the question.
If the question implies aggregation (e.g., "favorite hashtag"), compute it from the dataset
(e.g., count tag frequency and pick the most frequent). If insufficient, say so briefly.

DATASET (JSONL):
${jsonl}

QUESTION:
${userQuestion}

TASK:
1) Answer concisely using only the DATASET.
2) Include a short "Based on:" line citing tag(s) or id(s) used.`
  );
}

/* ---------- Rendering: Browse (waterfall) ---------- */
function renderItemCard(it) {
  const card = document.createElement('div'); card.className = 'item';

  const header = document.createElement('div'); header.className = 'item-header';
  const title = document.createElement('div'); title.className = 'item-title';
  title.textContent = it.title || (it.type === 'note' ? 'Note' : it.type.toUpperCase());
  const meta = document.createElement('div'); meta.className = 'item-meta';
  meta.textContent = `${it.type} • ${new Date(it.createdAt).toLocaleString()}`;
  header.appendChild(title); header.appendChild(meta); card.appendChild(header);

  const content = document.createElement('div'); content.className = 'item-content';
  content.textContent = it.content; card.appendChild(content);

  if ((it.tags || []).length > 0) {
    const hr = document.createElement('hr'); hr.className = 'sep'; card.appendChild(hr);
    const tagsRow = document.createElement('div');
    for (const t of it.tags) {
      const chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = `#${t}`;
      chip.addEventListener('click', () => { searchInput.value = `#${t}`; renderResults(); });
      tagsRow.appendChild(chip);
    }
    card.appendChild(tagsRow);
  }

  const actions = document.createElement('div'); actions.className = 'item-actions';
  if (it.type !== 'note') {
    const openBtn = document.createElement('button'); openBtn.className = 'btn'; openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => { try { window.open(it.content, '_blank'); } catch {} });
    const copyBtn = document.createElement('button'); copyBtn.className = 'btn'; copyBtn.textContent = 'Copy URL';
    copyBtn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(it.content); } catch {} });
    actions.appendChild(openBtn); actions.appendChild(copyBtn);
  }
  const delBtn = document.createElement('button'); delBtn.className = 'btn'; delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    const next = allItems.filter(x => x.id !== it.id);
    await saveItems(next); allItems = next; renderResults();
  });
  actions.appendChild(delBtn);
  card.appendChild(actions);

  return card;
}

function renderResults() {
  results.innerHTML = '';

  // Apply filters
  const q = searchInput.value || '';
  const { tags, text } = parseSearchQuery(q);

  let filtered = allItems.filter(it => {
    const textMatch =
      !text ||
      containsText(it.title, text) ||
      containsText(it.content, text) ||
      (it.tags || []).some(t => containsText(t, text));
    const tagMatch = tags.length === 0 || (it.tags || []).some(t => tags.includes(t));
    return textMatch && tagMatch;
  });

  // Sort
  const order = orderSelect.value;
  if (order === 'newest') {
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (order === 'oldest') {
    filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else if (order === 'title') {
    filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }

  // Cache EXACT list for chat
  lastFilteredItems = filtered.slice();

  // Group (waterfall)
  const grouped = groupByDate(filtered);
  for (const [label, items] of grouped) {
    const section = document.createElement('div'); section.className = 'section';
    const h = document.createElement('h3'); h.textContent = label; section.appendChild(h);
    for (const it of items) section.appendChild(renderItemCard(it));
    results.appendChild(section);
  }
}

/* ---------- Save: handler ---------- */
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = (titleInput.value || '').trim();
  const content = (contentInput.value || '').trim();
  const tags = normalizeTags(tagsInput.value);
  if (!content) return;

  const item = {
    id: crypto.randomUUID(),
    createdAt: nowISO(),
    title, content, tags,
    type: guessType(content)
  };

  const next = [item, ...allItems];
  await saveItems(next);
  allItems = next;

  titleInput.value = ''; contentInput.value = ''; tagsInput.value = '';
  saveStatus.textContent = 'Saved ✓'; setTimeout(() => (saveStatus.textContent = ''), 1200);

  if (!viewBrowse.classList.contains('hidden')) renderResults();
});

/* ---------- Browse: controls ---------- */
searchInput?.addEventListener('input', renderResults);
orderSelect?.addEventListener('change', renderResults);
clearFiltersBtn?.addEventListener('click', () => {
  searchInput.value = ''; orderSelect.value = 'newest'; renderResults();
});
exportBtn?.addEventListener('click', async () => {
  const obj = { exportedAt: nowISO(), items: allItems };
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'webstash-export.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});

/* ---------- Tabs ---------- */
function activateTab(which) {
  if (which === 'save') {
    tabSave.classList.add('active'); tabBrowse.classList.remove('active');
    viewSave.classList.remove('hidden'); viewBrowse.classList.add('hidden');
  } else {
    tabBrowse.classList.add('active'); tabSave.classList.remove('active');
    viewBrowse.classList.remove('hidden'); viewSave.classList.add('hidden');
    renderResults();
  }
}
tabSave.addEventListener('click', () => activateTab('save'));
tabBrowse.addEventListener('click', () => activateTab('browse'));

/* ---------- Inline Chat: UX wiring (no MAIN world) ---------- */
toggleChatBtn.addEventListener('click', () => {
  chatPanel.classList.toggle('hidden');
  if (!chatPanel.classList.contains('hidden')) inputPrompt.focus();
});

inputPrompt.addEventListener('input', () => {
  if (inputPrompt.value.trim()) buttonPrompt.removeAttribute('disabled');
  else buttonPrompt.setAttribute('disabled', '');
});

sliderTemperature.addEventListener('input', (e) => {
  labelTemperature.textContent = e.target.value;
  resetSession();
});
sliderTopK.addEventListener('input', (e) => {
  labelTopK.textContent = e.target.value;
  resetSession();
});

buttonReset.addEventListener('click', () => {
  hide(elementLoading); hide(elementError); hide(elementResponse);
  responseBody.textContent = '';
  resetSession();
  buttonReset.setAttribute('disabled', '');
});

buttonPrompt.addEventListener('click', async () => {
  const userQ = inputPrompt.value.trim();
  if (!userQ) return;
  showLoading();
  try {
    // Build JSONL from the EXACT filtered dataset the user is viewing
    const baseItems = (lastFilteredItems && lastFilteredItems.length) ? lastFilteredItems : allItems;
    const jsonl = itemsToJSONL(baseItems);

    // Compose the grounded prompt
    const groundedPrompt = buildGroundedPromptFromJSONL(jsonl, userQ);

    // Call your existing Prompt API (LanguageModel) — no MAIN world here
    const params = await getDefaultParams();
    const response = await runPrompt(groundedPrompt, params);
    showResponse(response);
  } catch (e) {
    showError(e);
  }
});

/* ---------- LanguageModel session helpers ---------- */
async function getDefaultParams() {
  // Initialize default sliders from model if available (first run)
  if (typeof LanguageModel !== 'undefined' && LanguageModel.params && !getDefaultParams._done) {
    try {
      const defaults = await LanguageModel.params();
      if (typeof defaults.defaultTemperature === 'number') {
        sliderTemperature.value = defaults.defaultTemperature.toFixed(1);
        labelTemperature.textContent = sliderTemperature.value;
      }
      if (typeof defaults.defaultTopK === 'number') {
        const topK = Math.min(defaults.defaultTopK, 3); // cap at 3 by your prior spec
        sliderTopK.value = String(topK);
        labelTopK.textContent = String(topK);
      }
      if (typeof defaults.maxTopK === 'number') {
        sliderTopK.max = String(defaults.maxTopK);
      }
    } catch {}
    getDefaultParams._done = true;
  }
  return {
    initialPrompts: [{ role: 'system', content: 'You are a helpful and friendly assistant.' }],
    temperature: Number(sliderTemperature.value),
    topK: Number(sliderTopK.value),
    outputLanguage: 'en'
  };
}

async function runPrompt(prompt, params) {
  try {
    if (!session) session = await LanguageModel.create(params);
    return session.prompt(prompt);
  } catch (e) {
    resetSession();
    throw e;
  }
}
function resetSession() {
  if (session) try { session.destroy(); } catch {}
  session = null;
}

/* ---------- Chat UI helpers ---------- */
function showLoading() {
  buttonReset.removeAttribute('disabled');
  hide(elementResponse); hide(elementError); show(elementLoading);
}
function showResponse(text) {
  hide(elementLoading);
  hide(elementError);
  show(elementResponse);

  // Case A: model already returned a JS object/array
  if (text && typeof text === 'object') {
    responseBody.innerHTML = renderJsonAsCards(text);
    elementResponse.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  // Case B: it's (probably) a string -> try to parse/extract JSON/JSONL
  const raw = (typeof text === 'string') ? text.trim() : String(text ?? '').trim();
  const parsed = tryParseJsonOrJsonL(raw);

  if (parsed) {
    responseBody.innerHTML = renderJsonAsCards(parsed);
  } else {
    responseBody.innerHTML = `<div class="ai-answer">${escapeHtml(raw)}</div>`;
  }

  elementResponse.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Parsing helpers (unchanged from earlier suggestion) ---------- */
function tryParseJsonOrJsonL(raw) {
  const s0 = stripBOM(raw);
  const s1 = stripCodeFences(s0);

  // Direct parse (entire payload is JSON)
  const direct = safeParseJson(s1);
  if (direct) return direct;

  // JSON Lines (each line an object)
  const jsonl = tryParseJsonLines(s1);
  if (jsonl) return jsonl;

  // Extract first top-level JSON block anywhere in the text
  const embedded = extractFirstTopLevelJson(s1);
  if (embedded) return embedded;

  return null;
}

function stripBOM(s) {
  return s.replace(/^\uFEFF/, '');
}

function stripCodeFences(s) {
  // ```json ... ``` or ``` ... ```
  const m = s.match(/^\s*```(?:json|javascript)?\s*([\s\S]*?)\s*```/i);
  return m ? m[1].trim() : s;
}

function safeParseJson(s) {
  try {
    const t = s.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return null;
    return JSON.parse(t);
  } catch { return null; }
}

function tryParseJsonLines(s) {
  const lines = s.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const items = [];
  let parsedCount = 0;
  for (const line of lines) {
    if (line.startsWith('{') && line.endsWith('}')) {
      const o = safeParseJson(line);
      if (o && typeof o === 'object') { items.push(o); parsedCount++; }
    }
  }
  return parsedCount ? items : null;
}

// Robustly extract the first balanced top-level {...} or [...] block.
function extractFirstTopLevelJson(s) {
  const idxObj = s.indexOf('{');
  const idxArr = s.indexOf('[');
  const start = (idxObj === -1) ? idxArr : (idxArr === -1 ? idxObj : Math.min(idxObj, idxArr));
  if (start < 0) return null;

  const openChar = s[start];
  const closeChar = (openChar === '{') ? '}' : ']';
  let depth = 0, inStr = false, esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (!esc && ch === '\\') { esc = true; continue; }
      if (!esc && ch === '"')  inStr = false;
      esc = false;
      continue;
    }

    if (ch === '"') { inStr = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        const parsed = safeParseJson(candidate);
        if (parsed) return parsed;
        break;
      }
    }
  }
  return null;
}

/* ---------- Pretty renderers ---------- */
function renderJsonAsCards(data) {
  const items = Array.isArray(data) ? data : [data];
  if (!items.length) return '<div class="muted">No data returned.</div>';
  return items.map(renderOneCard).join('');
}

function renderOneCard(item) {
  if (typeof item !== 'object' || item === null) {
    return `<div class="ai-answer">${escapeHtml(String(item))}</div>`;
  }

  // Prefer a title-like header if present
  const title = item.title || item.name || item.heading || '';
  const header = title
    ? `<div class="json-row title-row"><span class="json-title">${escapeHtml(title)}</span></div>`
    : '';

  const rows = Object.entries(item)
    .filter(([k]) => k !== 'title' && k !== 'name' && k !== 'heading')
    .map(([key, val]) => {
      let display;
      if (key === 'createdAt' && val) {
        const d = new Date(String(val));
        display = isNaN(d) ? String(val) : d.toLocaleString();
      } else if (Array.isArray(val)) {
        // e.g., tags -> "#rockets, #ai"
        display = val.map(v => (typeof v === 'string' ? `#${v}` : String(v))).join(', ');
      } else if (typeof val === 'object' && val !== null) {
        display = JSON.stringify(val);
      } else {
        display = String(val ?? '');
      }

      return `<div class="json-row">
                <span class="json-key">${escapeHtml(key)}:</span>
                <span class="json-value">${escapeHtml(display)}</span>
              </div>`;
    })
    .join('');

  return `<div class="json-card">${header}${rows}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function showError(err) {
  show(elementError); hide(elementResponse); hide(elementLoading);
  elementError.textContent = (err && err.message) ? err.message : String(err);
}
function show(elm) { elm.classList.remove('hidden'); }
function hide(elm) { elm.classList.add('hidden'); }

/* ---------- Init ---------- */
(async function init() {
  await loadItems();
  activateTab('save'); // default tab
  // Initialize labels
  labelTemperature.textContent = sliderTemperature.value;
  labelTopK.textContent = sliderTopK.value;
})();
