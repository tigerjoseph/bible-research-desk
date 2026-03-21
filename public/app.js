/**
 * Bible Research Desk — main application
 *
 * Progressive loading:
 *   1. db/verses.db.gz (~5MB) — Bible text, loads first → app immediately usable
 *   2. db/research.db.gz (~50MB) — words, commentary, lexicon → loaded in background
 *   3. transformers.js + Qwen2.5 (~200MB) — on-demand synthesis model
 *
 * Right panel: tabbed research guide
 *   Word click  → Word | Commentary | Fathers tabs
 *   Passage highlight → Commentary | Fathers | Synthesis tabs
 */

let versesDb = null;   // sql.js database for verse text
let researchDb = null; // sql.js database for research data
let modelReady = false;
let generator = null;  // transformers.js pipeline

let currentAbbrev = 'GEN';
let currentChapter = 1;
let currentTranslation = 'KJV';
let maxChapter = 50;
let verseWordsCache = {};

// ---------------------------------------------------------------------------
// Progressive DB Loading
// ---------------------------------------------------------------------------

async function fetchGzippedDb(url, onProgress) {
  const response = await fetch(url);
  const contentLength = +response.headers.get('Content-Length');
  const reader = response.body.getReader();
  let received = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (contentLength && onProgress) onProgress(received / contentLength);
  }
  const blob = new Blob(chunks);
  const ds = new DecompressionStream('gzip');
  const decompressedStream = blob.stream().pipeThrough(ds);
  const arrayBuffer = await new Response(decompressedStream).arrayBuffer();
  return arrayBuffer;
}

function updateLoadingProgress(message, progress) {
  const overlay = document.getElementById('loading-overlay');
  const statusEl = overlay.querySelector('.loading-status');
  const progressBar = overlay.querySelector('.loading-progress-fill');
  if (statusEl) statusEl.textContent = message;
  if (progressBar) progressBar.style.width = `${Math.round(progress * 100)}%`;
}

function updateBackgroundProgress(message, progress) {
  const indicator = document.getElementById('background-progress');
  if (!indicator) return;
  const statusEl = indicator.querySelector('.bg-progress-status');
  const progressBar = indicator.querySelector('.bg-progress-fill');
  if (statusEl) statusEl.textContent = message;
  if (progressBar) progressBar.style.width = `${Math.round(progress * 100)}%`;
  indicator.style.display = 'flex';
}

function hideBackgroundProgress() {
  const indicator = document.getElementById('background-progress');
  if (indicator) indicator.style.display = 'none';
}

async function initDB() {
  const SQL = await initSqlJs({
    locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
  });

  // Phase 1: Load verses.db.gz (essential)
  updateLoadingProgress('Loading Bible text...', 0);
  const versesBuf = await fetchGzippedDb('db/verses.db.gz', (p) => {
    updateLoadingProgress('Loading Bible text...', p * 0.9);
  });
  updateLoadingProgress('Initializing...', 0.95);
  versesDb = new SQL.Database(new Uint8Array(versesBuf));

  // Read URL params
  const params = new URLSearchParams(window.location.search);
  currentAbbrev = params.get('book') || 'GEN';
  currentChapter = parseInt(params.get('chapter'), 10) || 1;

  // Load initial UI
  await loadBookDropdown();
  loadTranslationDropdown();
  await loadChapter();
  bindEvents();

  // Hide loading overlay — app is usable
  updateLoadingProgress('Ready', 1);
  setTimeout(() => {
    const overlay = document.getElementById('loading-overlay');
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
  }, 200);

  // Phase 2: Load research.db.gz in background
  setTimeout(async () => {
    try {
      updateBackgroundProgress('Loading research data...', 0);
      const researchBuf = await fetchGzippedDb('db/research.db.gz', (p) => {
        updateBackgroundProgress('Loading research data...', p * 0.9);
      });
      updateBackgroundProgress('Initializing research data...', 0.95);
      researchDb = new SQL.Database(new Uint8Array(researchBuf));

      // Reload current chapter so word data populates
      loadChapter();

      updateBackgroundProgress('Research data ready', 1);
      setTimeout(hideBackgroundProgress, 1000);

      // Phase 3: Pre-download AI model in background (silent)
      preloadModel();
    } catch (err) {
      console.error('Failed to load research database:', err);
      updateBackgroundProgress('Research data unavailable', 1);
      setTimeout(hideBackgroundProgress, 3000);
    }
  }, 100);
}

// ---------------------------------------------------------------------------
// Data functions
// ---------------------------------------------------------------------------

function getBooks() {
  const stmt = versesDb.prepare('SELECT book_id, name, abbrev, testament FROM book_abbrevs ORDER BY book_id');
  const books = [];
  while (stmt.step()) books.push(stmt.getAsObject());
  stmt.free();
  return books;
}

function getMaxChapter(abbrev) {
  const versesTable = `${currentTranslation}_verses`;
  const stmt = versesDb.prepare(`
    SELECT MAX(v.chapter) as max_ch
    FROM ${versesTable} v
    JOIN book_abbrevs b ON b.book_id = v.book_id
    WHERE b.abbrev = ?
  `);
  stmt.bind([abbrev]);
  let max = 1;
  if (stmt.step()) max = stmt.getAsObject().max_ch || 1;
  stmt.free();
  return max;
}

function getChapter(abbrev, chapter) {
  const versesTable = `${currentTranslation}_verses`;
  const verseStmt = versesDb.prepare(`
    SELECT v.verse, v.text
    FROM ${versesTable} v
    JOIN book_abbrevs b ON b.book_id = v.book_id
    WHERE b.abbrev = ? AND v.chapter = ?
    ORDER BY v.verse
  `);
  verseStmt.bind([abbrev, chapter]);
  const verses = [];
  while (verseStmt.step()) verses.push(verseStmt.getAsObject());
  verseStmt.free();

  // Words come from research DB (if available)
  let wordsByVerse = {};
  if (researchDb) {
    const pattern = `${abbrev}.${chapter}.%`;
    const wordStmt = researchDb.prepare(`
      SELECT w.verse_id, w.position, w.english, w.strongs_number,
             w.original, w.transliteration, w.lemma, w.pos, w.grammar,
             sl.definition, sl.kjv_def, sl.derivation
      FROM words w
      LEFT JOIN strongs_lexicon sl ON w.strongs_number = sl.strongs_number
      WHERE w.verse_id LIKE ?
      ORDER BY w.verse_id, w.position
    `);
    wordStmt.bind([pattern]);
    while (wordStmt.step()) {
      const row = wordStmt.getAsObject();
      if (!wordsByVerse[row.verse_id]) wordsByVerse[row.verse_id] = [];
      wordsByVerse[row.verse_id].push(row);
    }
    wordStmt.free();
  }

  return { verses, wordsByVerse };
}

function getCommentary(verseIds) {
  if (!researchDb || !verseIds || verseIds.length === 0) return null;
  const placeholders = verseIds.map(() => '?').join(',');
  let stmt;
  try {
    stmt = researchDb.prepare(`
      SELECT verse_id, ivp_text, malina_text, church_fathers
      FROM commentary WHERE verse_id IN (${placeholders})
      ORDER BY verse_id
    `);
  } catch (e) { return null; }
  stmt.bind(verseIds);

  const result = { ivp: [], malina: [], fathers: [] };
  while (stmt.step()) {
    const row = stmt.getAsObject();
    if (row.ivp_text) result.ivp.push(row.ivp_text);
    if (row.malina_text) result.malina.push(row.malina_text);
    if (row.church_fathers) {
      try { result.fathers.push(...JSON.parse(row.church_fathers)); } catch (e) {}
    }
  }
  stmt.free();
  if (!result.ivp.length && !result.malina.length && !result.fathers.length) return null;
  return result;
}

// ---------------------------------------------------------------------------
// Rendering — dropdowns & chapter
// ---------------------------------------------------------------------------

async function loadBookDropdown() {
  const select = document.getElementById('book-select');
  const books = getBooks();
  select.innerHTML = '';
  for (const book of books) {
    const opt = document.createElement('option');
    opt.value = book.abbrev;
    opt.textContent = book.name;
    if (book.abbrev === currentAbbrev) opt.selected = true;
    select.appendChild(opt);
  }
}

function loadTranslationDropdown() {
  const select = document.getElementById('translation-select');
  if (!select) return;
  let translations = [];
  try {
    const stmt = versesDb.prepare('SELECT abbrev, name FROM translations_available ORDER BY abbrev');
    while (stmt.step()) translations.push(stmt.getAsObject());
    stmt.free();
  } catch (e) {
    translations = [
      { abbrev: 'KJV', name: 'King James Version' },
      { abbrev: 'YLT', name: "Young's Literal Translation" },
      { abbrev: 'BSB', name: 'Berean Study Bible' }
    ];
  }
  select.innerHTML = '';
  for (const t of translations) {
    const opt = document.createElement('option');
    opt.value = t.abbrev;
    opt.textContent = t.abbrev;
    if (t.abbrev === currentTranslation) opt.selected = true;
    select.appendChild(opt);
  }
}

async function loadChapter() {
  maxChapter = getMaxChapter(currentAbbrev);
  if (currentChapter < 1) currentChapter = 1;
  if (currentChapter > maxChapter) currentChapter = maxChapter;

  const url = new URL(window.location);
  url.searchParams.set('book', currentAbbrev);
  url.searchParams.set('chapter', currentChapter);
  history.pushState(null, '', url);

  document.getElementById('chapter-label').textContent = `Chapter ${currentChapter}`;
  document.getElementById('book-select').value = currentAbbrev;

  const { verses, wordsByVerse } = getChapter(currentAbbrev, currentChapter);
  verseWordsCache = wordsByVerse;

  const container = document.getElementById('bible-text');
  container.style.opacity = '0';
  container.innerHTML = '';

  for (const v of verses) {
    const verseId = `${currentAbbrev}.${currentChapter}.${v.verse}`;

    // Verse number
    const numSpan = document.createElement('span');
    numSpan.className = 'verse-num';
    numSpan.textContent = v.verse;
    container.appendChild(numSpan);

    // Each word is a span — no gaps between them, just textContent includes leading space
    const textWords = v.text.split(/\s+/);
    for (let i = 0; i < textWords.length; i++) {
      const span = document.createElement('span');
      span.className = 'word';
      span.dataset.verse = verseId;
      span.dataset.wordIdx = i;
      // Leading space inside the span so highlight is continuous (no white gaps)
      span.textContent = (i > 0 ? ' ' : '') + textWords[i];
      container.appendChild(span);
    }

    // Trailing space between verses
    container.appendChild(document.createTextNode(' '));
  }

  document.getElementById('bible-panel').scrollTop = 0;
  resetContextPanel();

  // Fade in
  requestAnimationFrame(() => {
    container.style.transition = 'opacity 250ms ease';
    container.style.opacity = '1';
  });
}

// ---------------------------------------------------------------------------
// Right panel — tabbed research guide
// ---------------------------------------------------------------------------

function verseRefLabel(verseId) {
  const parts = verseId.split('.');
  const bookSelect = document.getElementById('book-select');
  const bookName = bookSelect ? (bookSelect.querySelector(`option[value="${parts[0]}"]`)?.textContent || parts[0]) : parts[0];
  return `${bookName} ${parts[1]}:${parts[2]}`;
}

function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Show the research panel for a clicked word.
 * Tabs: Word | Commentary | Fathers
 */
function showWordResearch(verseId, wordIdx) {
  const panel = document.getElementById('context-content');

  if (!researchDb) {
    panel.innerHTML = '<p class="placeholder" style="margin-top:20vh">Loading research data...</p>';
    return;
  }

  let wordsData = verseWordsCache[verseId];

  // Fallback: if cache is empty, query research DB directly
  if ((!wordsData || wordsData.length === 0) && researchDb) {
    try {
      const stmt = researchDb.prepare(`
        SELECT w.verse_id, w.position, w.english, w.strongs_number,
               w.original, w.transliteration, w.lemma, w.pos, w.grammar,
               sl.definition, sl.kjv_def, sl.derivation
        FROM words w
        LEFT JOIN strongs_lexicon sl ON w.strongs_number = sl.strongs_number
        WHERE w.verse_id = ?
        ORDER BY w.position
      `);
      stmt.bind([verseId]);
      wordsData = [];
      while (stmt.step()) wordsData.push(stmt.getAsObject());
      stmt.free();
      if (wordsData.length > 0) {
        verseWordsCache[verseId] = wordsData;
      }
    } catch (e) {
      console.warn('Direct word query failed:', e);
    }
  }

  if (!wordsData || wordsData.length === 0) {
    panel.innerHTML = '<p class="placeholder">No original-language data for this verse</p>';
    return;
  }

  const commentary = getCommentary([verseId]);
  const hasCommentary = commentary && (commentary.ivp.length || commentary.malina.length);
  const hasFathers = commentary && commentary.fathers.length;

  // Count labels
  const commCount = (commentary ? commentary.ivp.length + commentary.malina.length : 0);
  const fatherCount = (commentary ? commentary.fathers.length : 0);

  let html = `<div class="research-panel" style="opacity:0;transition:opacity 180ms ease">`;

  // Header
  html += `<div class="research-header"><div class="verse-ref">${esc(verseRefLabel(verseId))}</div></div>`;

  // Tab bar
  html += `<div class="tab-bar">`;
  html += `<button class="tab-btn active" data-tab="word">Word<span class="tab-count">${wordsData.length}</span></button>`;
  if (hasCommentary) html += `<button class="tab-btn" data-tab="commentary">Commentary<span class="tab-count">${commCount}</span></button>`;
  if (hasFathers) html += `<button class="tab-btn" data-tab="fathers">Fathers<span class="tab-count">${fatherCount}</span></button>`;
  html += `</div>`;

  // --- Word tab ---
  html += `<div class="tab-panel active" data-tab="word">`;
  html += renderWordCards(wordsData, wordIdx);
  html += `</div>`;

  // --- Commentary tab ---
  if (hasCommentary) {
    html += `<div class="tab-panel" data-tab="commentary">`;
    html += renderCommentarySections(commentary);
    html += `</div>`;
  }

  // --- Fathers tab ---
  if (hasFathers) {
    html += `<div class="tab-panel" data-tab="fathers">`;
    html += renderFatherEntries(commentary.fathers);
    html += `</div>`;
  }

  html += `</div>`;
  panel.innerHTML = html;

  // Scroll the clicked word into view within the Word tab
  requestAnimationFrame(() => {
    panel.querySelector('.research-panel').style.opacity = '1';
    const highlighted = panel.querySelector('.word-card.highlighted');
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest' });
  });

  bindTabEvents(panel);
  bindCollapseEvents(panel);
}

/**
 * Show the research panel for a highlighted passage.
 * Tabs: Commentary | Fathers | Synthesis
 */
function showPassageResearch(verseIds, verseText) {
  const panel = document.getElementById('context-content');

  if (!researchDb) {
    panel.innerHTML = '<p class="placeholder" style="margin-top:20vh">Loading research data...</p>';
    return;
  }

  const commentary = getCommentary(verseIds);
  const hasCommentary = commentary && (commentary.ivp.length || commentary.malina.length);
  const hasFathers = commentary && commentary.fathers.length;

  // Build verse range label
  const first = verseIds[0], last = verseIds[verseIds.length - 1];
  const fp = first.split('.'), lp = last.split('.');
  const bookSelect = document.getElementById('book-select');
  const bookName = bookSelect ? (bookSelect.querySelector(`option[value="${fp[0]}"]`)?.textContent || fp[0]) : fp[0];
  const rangeLabel = first === last
    ? `${bookName} ${fp[1]}:${fp[2]}`
    : `${bookName} ${fp[1]}:${fp[2]}\u2013${lp[2]}`;

  const commCount = (commentary ? commentary.ivp.length + commentary.malina.length : 0);
  const fatherCount = (commentary ? commentary.fathers.length : 0);

  let html = `<div class="research-panel" style="opacity:0;transition:opacity 180ms ease">`;
  html += `<div class="research-header"><div class="verse-ref">${esc(rangeLabel)}</div></div>`;

  // Tab bar — first available tab is active
  const tabs = [];
  if (hasCommentary) tabs.push({ id: 'commentary', label: 'Commentary', count: commCount });
  if (hasFathers) tabs.push({ id: 'fathers', label: 'Fathers', count: fatherCount });
  tabs.push({ id: 'synthesis', label: 'Synthesis', count: '' });

  html += `<div class="tab-bar">`;
  tabs.forEach((t, i) => {
    const cls = i === 0 ? 'tab-btn active' : 'tab-btn';
    const countHtml = t.count ? `<span class="tab-count">${t.count}</span>` : '';
    html += `<button class="${cls}" data-tab="${t.id}">${t.label}${countHtml}</button>`;
  });
  html += `</div>`;

  // Commentary tab
  if (hasCommentary) {
    const active = tabs[0].id === 'commentary' ? ' active' : '';
    html += `<div class="tab-panel${active}" data-tab="commentary">`;
    html += renderCommentarySections(commentary);
    html += `</div>`;
  }

  // Fathers tab
  if (hasFathers) {
    const active = tabs[0].id === 'fathers' ? ' active' : '';
    html += `<div class="tab-panel${active}" data-tab="fathers">`;
    html += renderFatherEntries(commentary.fathers);
    html += `</div>`;
  }

  // Synthesis tab
  const synthActive = tabs[0].id === 'synthesis' ? ' active' : '';
  html += `<div class="tab-panel${synthActive}" data-tab="synthesis">`;
  html += `<div class="gemini-label">AI Synthesis</div>`;
  html += `<div id="synthesis-content" class="gemini-synthesis"></div>`;
  html += `</div>`;

  html += `</div>`;
  panel.innerHTML = html;

  requestAnimationFrame(() => {
    panel.querySelector('.research-panel').style.opacity = '1';
  });

  bindTabEvents(panel);
  bindCollapseEvents(panel);

  // Initialize synthesis UI
  initSynthesisTab(verseIds, verseText, commentary);
}

// ---------------------------------------------------------------------------
// Synthesis (transformers.js + Qwen2.5)
// ---------------------------------------------------------------------------

let modelLoading = false; // prevent duplicate loads

async function loadModel(onProgress) {
  if (modelLoading) return; // already loading
  modelLoading = true;

  const transformers = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');

  // Run ONNX inference in a Web Worker so the main thread stays responsive
  transformers.env.backends.onnx.wasm.proxy = true;

  generator = await transformers.pipeline('text-generation', 'onnx-community/Qwen2.5-0.5B-Instruct', {
    dtype: 'q4',
    progress_callback: (progress) => {
      if (progress.status === 'progress' && onProgress) {
        onProgress(progress.progress / 100);
      }
    }
  });
  modelReady = true;
}

// Silently preload model after research.db is ready
async function preloadModel() {
  try {
    updateBackgroundProgress('Preparing AI model...', 0);
    await loadModel((p) => {
      updateBackgroundProgress('Preparing AI model...', p);
    });
    updateBackgroundProgress('AI model ready', 1);
    setTimeout(hideBackgroundProgress, 1500);
  } catch (err) {
    console.warn('Model preload failed (will retry on demand):', err);
    modelLoading = false; // allow retry
    hideBackgroundProgress();
  }
}

function waitForModel() {
  return new Promise(resolve => {
    const check = setInterval(() => {
      if (modelReady) { clearInterval(check); resolve(); }
    }, 500);
  });
}

async function synthesize(verseText, commentaryContext) {
  if (!generator) throw new Error('Model not loaded');

  const messages = [
    { role: 'system', content: `You are a neutral academic reference tool. Given a Bible passage and scholarly commentary, synthesize the historical and cultural context in 150-250 words. Present only what the sources say. Use hedging language: "scholars note," "according to IVP," "Malina argues." Never assert, interpret, or editorialize. Cite which source each point comes from.` },
    { role: 'user', content: `Passage: ${verseText}\n\nScholarly Sources:\n${commentaryContext}\n\nSynthesize the historical and cultural context from these sources.` }
  ];

  const result = await generator(messages, { max_new_tokens: 512 });
  return result[0].generated_text.at(-1).content;
}

function buildCommentaryContextString(commentary) {
  if (!commentary) return '';
  const parts = [];
  if (commentary.ivp && commentary.ivp.length > 0) {
    parts.push('IVP Background: ' + commentary.ivp.join(' '));
  }
  if (commentary.malina && commentary.malina.length > 0) {
    parts.push('Malina Social-Science: ' + commentary.malina.join(' '));
  }
  if (commentary.fathers && commentary.fathers.length > 0) {
    const fatherTexts = commentary.fathers.slice(0, 5).map(f => {
      const author = f.author || 'Unknown';
      const quote = (f.quote || f.text || '').slice(0, 300);
      return `${author}: ${quote}`;
    });
    parts.push('Church Fathers: ' + fatherTexts.join(' | '));
  }
  return parts.join('\n\n');
}

function initSynthesisTab(verseIds, verseText, commentary) {
  const target = document.getElementById('synthesis-content');
  if (!target) return;

  if (modelReady) {
    // Model already loaded — run synthesis immediately
    runSynthesis(target, verseText, commentary);
  } else if (modelLoading) {
    // Model is downloading in background — wait for it
    target.innerHTML = '<p class="placeholder" style="margin-top:0">AI model is downloading... synthesis will run automatically.</p>';
    waitForModel().then(() => runSynthesis(target, verseText, commentary));
  } else {
    // Model not started — show download button
    target.innerHTML = `
      <div class="model-loader">
        <p class="model-info">This feature uses an on-device AI model (~200MB) that runs entirely in your browser.</p>
        <p class="model-info">After first download, the model is cached for instant future use.</p>
        <button id="load-model-btn" class="load-model-btn">Load AI Model</button>
      </div>
    `;

    const btn = document.getElementById('load-model-btn');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Loading model...';

      try {
        await loadModel((progress) => {
          btn.textContent = `Loading model... ${Math.round(progress * 100)}%`;
        });
        btn.textContent = 'Model loaded';
        runSynthesis(target, verseText, commentary);
      } catch (err) {
        console.error('Model load failed:', err);
        btn.textContent = 'Failed to load model';
        modelLoading = false;
        btn.disabled = false;
      }
    });
  }
}

async function runSynthesis(target, verseText, commentary) {
  target.innerHTML = '<p class="placeholder">Synthesizing...</p>';

  const commentaryContext = buildCommentaryContextString(commentary);

  try {
    const result = await synthesize(verseText, commentaryContext);

    // Typing animation
    target.innerHTML = '';
    const textEl = document.createElement('div');
    textEl.className = 'synthesis-text';
    target.appendChild(textEl);

    let i = 0;
    function typeChar() {
      if (i < result.length) {
        textEl.textContent += result[i];
        i++;
        setTimeout(typeChar, 8);
      }
    }
    typeChar();
  } catch (err) {
    console.error('Synthesis failed:', err);
    target.innerHTML = '<p class="placeholder">Synthesis unavailable. Please try again.</p>';
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderWordCards(wordsData, highlightIdx) {
  return wordsData.map((w, i) => {
    const cls = i === highlightIdx ? 'word-card highlighted' : 'word-card';
    const original = esc(w.original || '');
    const translit = esc(w.transliteration || '');
    const english = w.english ? esc(w.english) : '';
    const strongsNum = esc(w.strongs_number || '');
    const definition = esc(w.definition || w.kjv_def || '');
    const derivation = esc(w.derivation || '');

    return `
      <div class="${cls}">
        <div class="word-card-header">
          <span class="word-original">${original}</span>
          ${english ? `<span class="word-arrow">\u2192</span><span class="word-english-inline">${english}</span>` : ''}
        </div>
        ${translit ? `<div class="word-meta">${translit}${strongsNum ? ` \u00b7 ${strongsNum}` : ''}</div>` : ''}
        ${definition ? `<div class="word-def">${definition}</div>` : ''}
        ${derivation ? `<div class="word-derivation">${derivation}</div>` : ''}
      </div>
    `;
  }).join('');
}

function renderCommentarySections(commentary) {
  let html = '';
  if (commentary.ivp && commentary.ivp.length > 0) {
    html += `
      <div class="commentary-section">
        <div class="commentary-source">IVP Background Commentary</div>
        <div class="commentary-body">${commentary.ivp.map(t => esc(t)).join('<br><br>')}</div>
      </div>
    `;
  }
  if (commentary.malina && commentary.malina.length > 0) {
    html += `
      <div class="commentary-section">
        <div class="commentary-source">Malina Social-Science Commentary</div>
        <div class="commentary-body">${commentary.malina.map(t => esc(t)).join('<br><br>')}</div>
      </div>
    `;
  }
  return html;
}

function renderFatherEntries(fathers) {
  const INITIAL_SHOW = 3;
  let html = '';

  fathers.forEach((f, i) => {
    const hidden = i >= INITIAL_SHOW ? ' style="display:none"' : '';
    const author = esc(f.author || 'Unknown');
    const work = esc(f.work || '');
    let quote = f.quote || f.text || '';
    if (quote.length > 500) quote = quote.slice(0, 500) + '\u2026';
    quote = esc(quote);

    html += `
      <div class="father-entry" data-father-idx="${i}"${hidden}>
        <div class="father-author">${author}${work ? ' \u2014 ' + work : ''}</div>
        <div class="father-quote">${quote}</div>
      </div>
    `;
  });

  if (fathers.length > INITIAL_SHOW) {
    html += `<button class="show-more-btn" data-action="show-fathers">Show ${fathers.length - INITIAL_SHOW} more\u2026</button>`;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Tab & collapse interactions
// ---------------------------------------------------------------------------

function bindTabEvents(container) {
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      const bar = btn.closest('.tab-bar');
      const panel = bar.parentElement;

      // Deactivate all
      bar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      panel.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active');
        p.style.opacity = '0';
      });

      // Activate selected
      btn.classList.add('active');
      const target = panel.querySelector(`.tab-panel[data-tab="${tabId}"]`);
      if (target) {
        target.classList.add('active');
        requestAnimationFrame(() => { target.style.opacity = '1'; });
      }
    });
  });

  // Show more fathers
  container.querySelectorAll('.show-more-btn[data-action="show-fathers"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabPanel = btn.closest('.tab-panel');
      tabPanel.querySelectorAll('.father-entry[style]').forEach(el => {
        el.style.display = '';
      });
      btn.remove();
    });
  });
}

function bindCollapseEvents(container) {
  container.querySelectorAll('.commentary-source').forEach(el => {
    el.addEventListener('click', () => {
      el.closest('.commentary-section').classList.toggle('collapsed');
    });
  });
}

function resetContextPanel() {
  const panel = document.getElementById('context-content');
  panel.innerHTML = '<p class="placeholder">Click a word or highlight a passage</p>';
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function bindEvents() {
  // Word click — show that word's etymology + verse context in tabs
  document.getElementById('bible-text').addEventListener('click', (e) => {
    const wordEl = e.target.closest('.word');
    if (!wordEl) return;

    const verseId = wordEl.dataset.verse;
    const wordIdx = parseInt(wordEl.dataset.wordIdx, 10);
    if (!verseId) return;

    // Clear previous highlights
    document.querySelectorAll('.word.active-word').forEach(el => el.classList.remove('active-word'));
    document.querySelectorAll('.word.active-verse').forEach(el => el.classList.remove('active-verse'));

    // Highlight only the clicked word
    wordEl.classList.add('active-word');

    showWordResearch(verseId, wordIdx);
  });

  // Text selection (passage highlight)
  document.getElementById('bible-text').addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    setTimeout(async () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;

      const range = sel.getRangeAt(0);
      const container = document.getElementById('bible-text');
      const wordEls = container.querySelectorAll('.word');
      const selectedVerseIds = new Set();
      const selectedTexts = [];

      for (const el of wordEls) {
        if (range.intersectsNode(el)) {
          selectedVerseIds.add(el.dataset.verse);
          selectedTexts.push(el.textContent.trim());
        }
      }

      if (selectedVerseIds.size === 0) return;

      const verseIds = [...selectedVerseIds];
      const verseText = selectedTexts.join(' ');

      showPassageResearch(verseIds, verseText);
    }, 200);
  });

  // Book dropdown
  document.getElementById('book-select').addEventListener('change', (e) => {
    currentAbbrev = e.target.value;
    currentChapter = 1;
    loadChapter();
  });

  // Translation dropdown
  document.getElementById('translation-select').addEventListener('change', (e) => {
    currentTranslation = e.target.value;
    loadChapter();
  });

  // Prev/next
  document.getElementById('prev-chapter').addEventListener('click', () => navigateChapter(-1));
  document.getElementById('next-chapter').addEventListener('click', () => navigateChapter(1));

  // Arrow keys
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); navigateChapter(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); navigateChapter(1); }
  });

  // Browser back/forward
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    currentAbbrev = params.get('book') || 'GEN';
    currentChapter = parseInt(params.get('chapter'), 10) || 1;
    document.getElementById('book-select').value = currentAbbrev;
    loadChapter();
  });
}

function navigateChapter(delta) {
  const next = currentChapter + delta;
  if (next < 1) {
    const books = getBooks();
    const idx = books.findIndex(b => b.abbrev === currentAbbrev);
    if (idx > 0) {
      currentAbbrev = books[idx - 1].abbrev;
      currentChapter = getMaxChapter(currentAbbrev);
      document.getElementById('book-select').value = currentAbbrev;
      loadChapter();
    }
    return;
  }
  if (next > maxChapter) {
    const books = getBooks();
    const idx = books.findIndex(b => b.abbrev === currentAbbrev);
    if (idx < books.length - 1) {
      currentAbbrev = books[idx + 1].abbrev;
      currentChapter = 1;
      document.getElementById('book-select').value = currentAbbrev;
      loadChapter();
    }
    return;
  }
  currentChapter = next;
  loadChapter();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', initDB);
