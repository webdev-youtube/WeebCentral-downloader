/* Manga Downloader — 100% client-side WeebCentral downloader.
 * No backend. Runs entirely in the browser.
 */

const state = { manga: null, aborter: null };

// ---------- DOM ----------
const mangaUrlInput  = document.getElementById('mangaUrl');
const fetchBtn        = document.getElementById('fetchBtn');
const fetchStatusEl   = document.getElementById('fetchStatus');
const stepperEl       = document.getElementById('stepper');
const resultCard      = document.getElementById('resultCard');
const coverImgEl      = document.getElementById('coverImg');
const mangaTitleEl    = document.getElementById('mangaTitle');
const chapterCountEl  = document.getElementById('chapterCount');
const chapterListEl   = document.getElementById('chapterList');
const selectAllBtn    = document.getElementById('selectAllBtn');
const selectNoneBtn   = document.getElementById('selectNoneBtn');
const rangeField       = document.getElementById('rangeField');
const applyRangeBtn    = document.getElementById('applyRangeBtn');
const downloadBtn     = document.getElementById('downloadBtn');
const cancelBtn       = document.getElementById('cancelBtn');
const progressWrap    = document.getElementById('progressWrap');
const progressFillEl  = document.getElementById('progressFill');
const progressLabelEl = document.getElementById('progressLabel');
const customProxyEl   = document.getElementById('customProxy');
const helpToggle      = document.getElementById('helpToggle');
const helpBody        = document.getElementById('helpBody');
const logToggle       = document.getElementById('logToggle');
const logWrap         = document.getElementById('logWrap');
const logPanel        = document.getElementById('logPanel');
const logCountEl      = document.getElementById('logCount');
const pathBadge       = document.getElementById('pathBadge');
const copyLogBtn      = document.getElementById('copyLogBtn');
const clearLogBtn     = document.getElementById('clearLogBtn');

// ---------- disclosures ----------
function wireDisclosure(toggleBtn, bodyEl){
  toggleBtn.addEventListener('click', () => {
    const open = !bodyEl.classList.contains('hidden');
    bodyEl.classList.toggle('hidden', open);
    toggleBtn.classList.toggle('open', !open);
  });
}
wireDisclosure(helpToggle, helpBody);
wireDisclosure(logToggle, logWrap);

copyLogBtn.addEventListener('click', () => {
  const text = Array.from(logPanel.children).map(el => el.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    copyLogBtn.textContent = 'Copied';
    setTimeout(() => { copyLogBtn.textContent = 'Copy log'; }, 1200);
  });
});
clearLogBtn.addEventListener('click', () => resetLog());

// ---------- copy buttons ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-copy');
  if(!btn) return;
  const text = btn.dataset.copy ?? document.getElementById(btn.dataset.copyTarget)?.textContent ?? '';
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
  });
});

// ---------- structured log ----------
const MAX_LOG_LINES = 300;
let logLines = 0;
function logEvent(level, msg){
  logLines++;
  logCountEl.textContent = `(${logLines})`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const row = document.createElement('div');
  row.className = `log-line ${level}`;
  row.innerHTML = `<span class="t mono">${time}</span><span>${escapeHtml(msg)}</span>`;
  if(logPanel.querySelector('.log-empty')) logPanel.innerHTML = '';
  logPanel.appendChild(row);
  while(logPanel.children.length > MAX_LOG_LINES) logPanel.removeChild(logPanel.firstChild);
  logPanel.scrollTop = logPanel.scrollHeight;
}
function resetLog(){
  logLines = 0;
  logCountEl.textContent = '';
  logPanel.innerHTML = '<div class="log-empty">Nothing yet.</div>';
}
function setPathBadge(label){
  if(!label || label === 'direct'){ pathBadge.classList.add('hidden'); return; }
  pathBadge.textContent = `via ${label}`;
  pathBadge.classList.remove('hidden');
}

// ---------- status line (with spinner / check / x) ----------
function setStatus(el, msg, kind){
  el.classList.remove('err', 'ok');
  if(kind === 'busy'){
    el.innerHTML = `<span class="spinner"></span><span>${escapeHtml(msg)}</span>`;
  }else{
    el.textContent = msg;
    if(kind) el.classList.add(kind);
  }
}

// ---------- stepper (fetch page → chapter list → ready) ----------
function setStep(activeIndex, doneUpTo = -1){
  stepperEl.classList.remove('hidden');
  Array.from(stepperEl.children).forEach((el, i) => {
    el.classList.toggle('active', i === activeIndex);
    el.classList.toggle('done', i <= doneUpTo && i !== activeIndex);
  });
}

// ---------- small utils ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function sanitizeName(name){
  return String(name).replace(/[\\/*?:"<>|]/g, '_').trim().slice(0, 120) || 'untitled';
}
function absUrl(u){
  if(!u) return u;
  try{ return new URL(u, 'https://weebcentral.com').href; }catch{ return u; }
}
function extFromResponse(url, blob){
  const map = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif', 'image/avif':'avif' };
  if(map[blob.type]) return map[blob.type];
  const m = url.match(/\.(jpe?g|png|webp|gif|avif)(?:\?|#|$)/i);
  if(m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  return 'jpg';
}
function saveBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ---------- persisted settings ----------
const LS_PROXY_KEY = 'mangadl.customProxy';
const LS_LASTWORK_KEY = 'mangadl.lastWorkingPath';
customProxyEl.value = localStorage.getItem(LS_PROXY_KEY) || '';
customProxyEl.addEventListener('change', () => {
  localStorage.setItem(LS_PROXY_KEY, customProxyEl.value.trim());
});

// ---------- CORS-resilient fetch ----------
// A CORS block is deterministic — the exact same cross-origin request will
// fail again and again, it's not a transient network blip. So: try direct
// once per fetch-session (reset each time the user hits Fetch), and the
// moment it fails, stop trying it for every subsequent request in that
// session — go straight to whatever's already proven to work. This is what
// was causing hundreds of pointless retries (and log spam) during a big
// chapter download: direct was being retried for every single image.
let directBlocked = false;
// When WeebCentral 429s us (we're going too fast through a shared proxy IP),
// pause every in-flight/upcoming request together for a bit. Without this,
// each of the 5 concurrent workers independently backs off ~500ms and they
// all retry at basically the same moment, instantly re-triggering the same
// rate limit.
let cooldownUntil = 0;

const PUBLIC_PROXIES = [
  { id: 'pub1', build: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  { id: 'pub2', build: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { id: 'pub3', build: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
];

function shuffled(arr){
  const a = arr.slice();
  for(let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildAttempts(){
  const attempts = directBlocked ? [] : [{ id: 'direct', label: 'direct', build: u => u }];

  const lastWorking = localStorage.getItem(LS_LASTWORK_KEY);

  const custom = customProxyEl.value.trim();
  const customAttempt = custom ? {
    id: 'custom',
    label: 'your proxy',
    build: u => custom.includes('{url}') ? custom.replace('{url}', encodeURIComponent(u)) : custom + encodeURIComponent(u),
  } : null;

  const publicAttempts = shuffled(PUBLIC_PROXIES).map(p => ({
    id: p.id, label: `public proxy (${p.id})`, build: p.build,
  }));

  let ordered = [...(customAttempt ? [customAttempt] : []), ...publicAttempts];

  if(lastWorking){
    const idx = ordered.findIndex(a => a.id === lastWorking);
    if(idx > 0){
      const [hit] = ordered.splice(idx, 1);
      ordered.unshift(hit);
    }
  }

  return [...attempts, ...ordered];
}

// extraHeaders: WeebCentral's chapter-list and chapter-image endpoints are
// AJAX partials — sending these hints matches how the site's own front-end
// requests them and avoids getting a redirect/error page instead of the
// fragment. Proxies may or may not forward them; harmless either way.
// quiet: when true, only log failures, not the success line — used for the
// bulk per-image downloads where a per-file log line is pure noise once a
// working path is established (progress is reported separately instead).
async function fetchResource(url, { binary = false, retries = 2, signal, extraHeaders, quiet = false } = {}){
  const attempts = buildAttempts();
  let lastErr;
  for(const attempt of attempts){
    const attemptRetries = attempt.id === 'direct' ? 0 : retries;
    for(let tryNum = 0; tryNum <= attemptRetries; tryNum++){
      if(signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Respect any active shared cooldown before firing.
      const wait = cooldownUntil - Date.now();
      if(wait > 0) await sleep(wait + Math.random() * 200);

      try{
        const res = await fetch(attempt.build(url), {
          mode: 'cors',
          referrerPolicy: 'no-referrer',
          signal,
          headers: extraHeaders,
        });
        if(!res.ok){
          const err = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          err.retryAfter = res.headers.get('retry-after');
          throw err;
        }
        const data = binary ? await res.blob() : await res.text();
        if(!binary && typeof data === 'string' && /Just a moment|Enable JavaScript and cookies|Checking your browser/i.test(data)){
          throw new Error('hit a Cloudflare challenge page');
        }
        if(binary && data.size === 0) throw new Error('empty response');
        if(!quiet) logEvent('ok', `${url.replace('https://weebcentral.com', '')} — ${attempt.label} ✓${tryNum ? ` (attempt ${tryNum + 1})` : ''}`);
        if(attempt.id !== 'direct'){
          localStorage.setItem(LS_LASTWORK_KEY, attempt.id);
          setPathBadge(attempt.label);
        }
        return { data, via: attempt.label };
      }catch(e){
        if(e.name === 'AbortError') throw e;
        lastErr = e;
        if(attempt.id === 'direct'){
          if(!directBlocked){
            directBlocked = true;
            logEvent('warn', `Direct requests are CORS-blocked this session — switching to proxy for everything else.`);
          }
        }else if(e.status === 429){
          const cooldownMs = e.retryAfter ? parseFloat(e.retryAfter) * 1000 : 4000 + Math.random() * 2000;
          const until = Date.now() + cooldownMs;
          if(until > cooldownUntil){
            cooldownUntil = until;
            logEvent('warn', `Getting rate-limited (HTTP 429) — pausing all requests for ~${Math.round(cooldownMs / 1000)}s to cool down.`);
          }
        }else{
          logEvent('warn', `${url.replace('https://weebcentral.com', '')} — ${attempt.label} failed: ${e.message}`);
        }
        if(tryNum < attemptRetries){
          const base = e.status === 429 ? 1500 : 500;
          await sleep(base * (tryNum + 1) + Math.random() * 300);
        }
      }
    }
  }
  throw new Error(`couldn't reach it after trying ${attempts.length} path(s) — last error: ${lastErr?.message || 'unknown'}`);
}

// ---------- concurrency pool ----------
async function runPool(items, worker, concurrency, signal){
  const results = new Array(items.length);
  let idx = 0;
  async function next(){
    while(idx < items.length){
      if(signal?.aborted) return;
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

// ---------- parsing WeebCentral ----------
function extractSeriesId(inputUrl){
  const m = inputUrl.match(/series\/([A-Za-z0-9]+)/);
  if(!m) throw new Error("couldn't find a series ID in that URL — paste a link like https://weebcentral.com/series/xxxxxxxx/Manga-Name");
  return m[1];
}

function parseMangaMeta(doc){
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
  const h1 = doc.querySelector('h1')?.textContent?.trim();
  const title = (ogTitle || h1 || 'Unknown manga').replace(/\s*\|\s*Weeb\s*Central\s*$/i, '').trim();

  const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
  const altImg = doc.querySelector("img[alt$='cover']")?.getAttribute('src');
  const cover = absUrl(ogImage || altImg);

  return { title: title || 'Unknown manga', cover };
}

function parseChapterAnchors(doc){
  const selectorChain = [
    'div[x-data] > a[href*="/chapters/"]',
    'a[href*="/chapters/"]',
  ];

  let anchors = [];
  for(const sel of selectorChain){
    anchors = Array.from(doc.querySelectorAll(sel));
    if(anchors.length) break;
  }

  const seen = new Map();
  for(const a of anchors){
    const href = absUrl(a.getAttribute('href'));
    if(!href || seen.has(href)) continue;
    let name = (a.querySelector('span.flex > span')?.textContent || a.textContent || 'Chapter')
      .replace(/Last Read.*$/is, '')
      .replace(/\s+/g, ' ')
      .trim();
    if(!name) name = 'Chapter';
    seen.set(href, name);
  }

  let chapters = Array.from(seen, ([url, name]) => ({ url, name }));

  const numbered = chapters.map(c => ({ ...c, n: parseFloat((c.name.match(/(\d+(\.\d+)?)/) || [])[1]) }));
  const allNumbered = numbered.every(c => !Number.isNaN(c.n));
  if(allNumbered && numbered.length > 1){
    numbered.sort((a, b) => a.n - b.n);
    chapters = numbered.map(({ n, ...rest }) => rest);
  }else{
    chapters.reverse();
  }
  return chapters;
}

async function loadManga(){
  const raw = mangaUrlInput.value.trim();
  if(!raw){ setStatus(fetchStatusEl, 'Paste a WeebCentral manga URL first.', 'err'); return; }

  let seriesId;
  try{ seriesId = extractSeriesId(raw); }
  catch(e){ setStatus(fetchStatusEl, e.message, 'err'); return; }

  const seriesUrl = raw.startsWith('http') ? raw : `https://${raw}`;
  fetchBtn.disabled = true;
  resetLog();
  directBlocked = false;
  pathBadge.classList.add('hidden');
  setStep(0);
  setStatus(fetchStatusEl, 'Fetching manga page…', 'busy');

  try{
    const { data: html } = await fetchResource(seriesUrl, { retries: 2 });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const { title, cover } = parseMangaMeta(doc);

    setStep(1, 0);
    setStatus(fetchStatusEl, 'Fetching chapter list…', 'busy');
    await sleep(350); // small stagger — avoids tripping proxy rate limits back-to-back

    const chapterListUrl = `https://weebcentral.com/series/${seriesId}/full-chapter-list`;
    const { data: chHtml } = await fetchResource(chapterListUrl, {
      retries: 2,
      extraHeaders: { 'HX-Request': 'true' },
    });

    const chDoc = new DOMParser().parseFromString(chHtml, 'text/html');
    const chapters = parseChapterAnchors(chDoc);

    if(chapters.length === 0) throw new Error('no chapters found — WeebCentral may have changed its page markup');

    state.manga = { title, cover, chapters };
    setStep(2, 1);
    renderManga();
    setStatus(fetchStatusEl, `Loaded ${chapters.length} chapters.`, 'ok');
  }catch(e){
    console.error(e);
    setStatus(fetchStatusEl, `Failed: ${e.message}`, 'err');
    helpBody.classList.remove('hidden');
    helpToggle.classList.add('open');
    logWrap.classList.remove('hidden');
    logToggle.classList.add('open');
  }finally{
    fetchBtn.disabled = false;
  }
}

function renderManga(){
  resultCard.classList.remove('hidden');
  coverImgEl.src = state.manga.cover || '';
  coverImgEl.onerror = () => { coverImgEl.style.visibility = 'hidden'; };
  mangaTitleEl.textContent = state.manga.title;
  chapterCountEl.textContent = `${state.manga.chapters.length} chapters found`;

  chapterListEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.manga.chapters.forEach((ch, i) => {
    const row = document.createElement('div');
    row.className = 'chapter-row';
    row.id = `row-${i}`;
    row.innerHTML = `<input type="checkbox" id="ch-${i}" checked><label for="ch-${i}">${i + 1}. ${escapeHtml(ch.name)}</label>`;
    frag.appendChild(row);
  });
  chapterListEl.appendChild(frag);

  progressWrap.classList.add('hidden');
  setProgress(0, '');
}

function setProgress(pct, label){
  progressFillEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if(label) progressLabelEl.textContent = label;
}

function getSelectedChapters(){
  return state.manga.chapters.filter((_, i) => document.getElementById(`ch-${i}`)?.checked);
}

function setAllChapters(checked){
  state.manga.chapters.forEach((_, i) => {
    const box = document.getElementById(`ch-${i}`);
    if(box) box.checked = checked;
  });
}

function applyRange(){
  const val = rangeField.value.trim();
  if(!val || !state.manga) return;
  const total = state.manga.chapters.length;
  const wanted = new Set();
  val.split(',').forEach(part => {
    part = part.trim();
    if(!part) return;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if(range){
      let a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      if(a > b) [a, b] = [b, a];
      for(let n = a; n <= b; n++) wanted.add(n);
    }else if(/^\d+$/.test(part)){
      wanted.add(parseInt(part, 10));
    }
  });
  for(let i = 0; i < total; i++){
    const box = document.getElementById(`ch-${i}`);
    if(box) box.checked = wanted.has(i + 1);
  }
}

// ---------- image fetching & packaging ----------
const SKIP_SRC_PATTERN = /\/static\/images\/|brand\.png|favicon|avatar|broken_image/i;

async function getChapterImages(chapter, signal){
  const url = `${chapter.url}/images?reading_style=long_strip`;
  const { data: html } = await fetchResource(url, {
    retries: 2, signal, extraHeaders: { 'HX-Request': 'true' },
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const selectorChain = ['main img[src]', 'section img[src]', 'img[src]'];
  let imgs = [];
  for(const sel of selectorChain){
    imgs = Array.from(doc.querySelectorAll(sel));
    if(imgs.length) break;
  }

  const seen = new Set();
  return imgs
    .map(img => img.getAttribute('src'))
    .filter(src => src && /^https?:\/\//i.test(src) && !SKIP_SRC_PATTERN.test(src))
    .filter(src => (seen.has(src) ? false : (seen.add(src), true)));
}

function blobToCanvasJpeg(blob){
  return new Promise((resolve, reject) => {
    const objUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      URL.revokeObjectURL(objUrl);
      resolve({ dataUrl, w: canvas.width, h: canvas.height });
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('image failed to decode')); };
    img.src = objUrl;
  });
}

async function buildPdf(blobs, onProgress){
  const { jsPDF } = window.jspdf;
  let doc;
  for(let i = 0; i < blobs.length; i++){
    const { dataUrl, w, h } = await blobToCanvasJpeg(blobs[i]);
    const orientation = w > h ? 'l' : 'p';
    if(!doc){
      doc = new jsPDF({ orientation, unit: 'px', format: [w, h], compress: true });
    }else{
      doc.addPage([w, h], orientation);
    }
    doc.addImage(dataUrl, 'JPEG', 0, 0, w, h, undefined, 'FAST');
    onProgress?.(i + 1, blobs.length);
  }
  return doc.output('blob');
}

async function downloadAll(){
  if(!state.manga) return;
  const selected = getSelectedChapters();
  if(selected.length === 0){ setProgress(0, 'Pick at least one chapter first.'); return; }

  const wantZip = document.getElementById('outZip').checked;
  const wantPdf = document.getElementById('outPdf').checked;
  if(!wantZip && !wantPdf){ setProgress(0, 'Pick ZIP, PDF, or both.'); return; }

  state.aborter = new AbortController();
  const { signal } = state.aborter;

  downloadBtn.disabled = true;
  downloadBtn.classList.add('hidden');
  cancelBtn.classList.remove('hidden');
  progressWrap.classList.remove('hidden');
  logWrap.classList.remove('hidden');
  logToggle.classList.add('open');
  setProgress(0, `Reading image lists for ${selected.length} chapter(s)…`);

  try{
    const chapterImages = await runPool(selected, async (ch) => ({
      chapter: ch,
      images: await getChapterImages(ch, signal),
    }), 2, signal);

    if(signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const totalImages = chapterImages.reduce((s, c) => s + c.images.length, 0);
    if(totalImages === 0) throw new Error('no images found in the selected chapters');

    let done = 0;
    const zip = wantZip ? new JSZip() : null;
    const pdfBlobs = [];

    for(const { chapter, images } of chapterImages){
      if(signal.aborted) break;
      const folder = zip ? zip.folder(sanitizeName(chapter.name)) : null;
      const chapterBlobs = new Array(images.length);

      await runPool(images, async (imgUrl, i) => {
        if(signal.aborted) return;
        try{
          const { data: blob } = await fetchResource(imgUrl, { binary: true, retries: 2, signal, quiet: true });
          chapterBlobs[i] = blob;
        }catch(e){
          if(e.name !== 'AbortError') logEvent('error', `Skipped an image in "${chapter.name}": ${e.message}`);
        }
        done++;
        if(done % 25 === 0 || done === totalImages){
          logEvent('info', `Progress: ${done}/${totalImages} images downloaded`);
        }
        setProgress(Math.round((done / totalImages) * 88), `Downloading images… ${done}/${totalImages}`);
      }, 3, signal);

      chapterBlobs.forEach((blob, i) => {
        if(!blob) return;
        if(folder) folder.file(`${String(i + 1).padStart(3, '0')}.${extFromResponse(images[i], blob)}`, blob);
        if(wantPdf) pdfBlobs.push(blob);
      });
    }

    if(signal.aborted) throw new DOMException('Aborted', 'AbortError');

    if(wantZip){
      setProgress(90, 'Packing ZIP…');
      const zipBlob = await zip.generateAsync({ type: 'blob' }, meta => {
        setProgress(90 + Math.round(meta.percent * 0.05), 'Packing ZIP…');
      });
      saveBlob(zipBlob, `${sanitizeName(state.manga.title)}.zip`);
    }

    if(wantPdf){
      const base = wantZip ? 96 : 90;
      const span = wantZip ? 4 : 10;
      setProgress(base, 'Building PDF (this can take a while for long chapters)…');
      const pdfBlob = await buildPdf(pdfBlobs, (done2, total2) => {
        setProgress(base + Math.round((done2 / total2) * span), `Building PDF… ${done2}/${total2} pages`);
      });
      saveBlob(pdfBlob, `${sanitizeName(state.manga.title)}.pdf`);
    }

    setProgress(100, `Done — ${totalImages} images across ${selected.length} chapter(s).`);
  }catch(e){
    if(e.name === 'AbortError'){
      setProgress(0, 'Cancelled.');
    }else{
      console.error(e);
      setProgress(0, `Failed: ${e.message}`);
    }
  }finally{
    downloadBtn.disabled = false;
    downloadBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    state.aborter = null;
  }
}

function cancelDownload(){
  state.aborter?.abort();
}

// ---------- wire up ----------
fetchBtn.addEventListener('click', loadManga);
mangaUrlInput.addEventListener('keydown', e => { if(e.key === 'Enter') loadManga(); });
selectAllBtn.addEventListener('click', () => setAllChapters(true));
selectNoneBtn.addEventListener('click', () => setAllChapters(false));
applyRangeBtn.addEventListener('click', applyRange);
downloadBtn.addEventListener('click', downloadAll);
cancelBtn.addEventListener('click', cancelDownload);
resetLog();
