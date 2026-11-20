// Waxingmachine9000 – käyttöliittymä. Kaikki laskenta tehdään WaxCoressa (src/core.js).
(function () {
  'use strict';

  const SETTINGS_KEY = 'wax9000.settings';
  const CONDITIONS_KEY = 'wax9000.conditions';
  const DB_NAME = 'wax9000';
  const STORE = 'handles';

  const $ = (sel) => document.querySelector(sel);
  const state = { dataset: null, files: [], dirHandle: null, settings: loadSettings() };

  // ---------- apurit ----------

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function fmt(n, digits = 1) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '–';
    return n.toLocaleString('fi-FI', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function parseNum(s) {
    const t = String(s ?? '').trim().replace(',', '.').replace('−', '-');
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }

  function storageGet(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ei tallennusta */ }
  }

  function loadSettings() {
    const defaults = JSON.parse(JSON.stringify(WaxCore.DEFAULT_SETTINGS));
    const saved = storageGet(SETTINGS_KEY);
    return saved ? { ...defaults, ...saved, importance: { ...defaults.importance, ...(saved.importance || {}) } } : defaults;
  }

  // ---------- kansiokahvan muistaminen (IndexedDB) ----------

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  const saveHandle = (h) => idb('readwrite', (s) => s.put(h, 'dir')).catch(() => {});
  const getHandle = () => idb('readonly', (s) => s.get('dir')).catch(() => null);
  // Ladatut CSV:t tallennetaan selaimeen, jotta data säilyy laitteella (iPhone, offline).
  const saveFiles = (files) => idb('readwrite', (s) => s.put(files, 'files')).catch(() => {});
  const getFiles = () => idb('readonly', (s) => s.get('files')).catch(() => null);
  const clearFiles = () => idb('readwrite', (s) => s.delete('files')).catch(() => {});

  // ---------- datan lataus ----------

  async function readDirectory(handle) {
    const files = [];
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.csv')) {
        const f = await entry.getFile();
        files.push({ name: f.name, lastModified: f.lastModified, text: await f.text() });
      }
    }
    return files;
  }

  async function useDirectory(handle) {
    state.dirHandle = handle;
    $('#reload-dir').hidden = false;
    $('#restore-dir').hidden = true;
    const files = await readDirectory(handle);
    useFiles(files, handle.name);
  }

  function useFiles(files, sourceName, { persist = true } = {}) {
    if (files.length === 0) {
      setStatus(`Kansiosta ${sourceName ? `"${sourceName}" ` : ''}ei löytynyt CSV-tiedostoja.`, true);
      return;
    }
    try {
      state.dataset = WaxCore.loadReports(files);
    } catch (e) {
      setStatus(`Datan luku epäonnistui: ${e.message}`, true);
      return;
    }
    state.files = files;
    if (persist) saveFiles(files);
    $('#clear-data').hidden = false;
    const s = state.dataset.stats;
    setStatus(
      `${s.files} ${s.files === 1 ? 'tiedosto' : 'tiedostoa'} · voidetestejä ${s.waxTests} · kuviotestejä ${s.patternTests} · ` +
        `${s.rows} riviä · ${s.firstDate} – ${s.lastDate}` +
        (s.duplicatesRemoved ? ` · ${s.duplicatesRemoved} duplikaattiriviä poistettu` : '') +
        (s.skippedFiles.length ? ` · ohitettu tuntematon tiedosto: ${s.skippedFiles.join(', ')}` : '') +
        ' · tallennettu tälle laitteelle',
    );
    fillPlaces(s.places);
    fillBrands(s.brands);
    update();
  }

  function setStatus(text, isError = false) {
    const el = $('#data-status');
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  function fillPlaces(places) {
    const sel = $('#conditions select[name=place]');
    const current = sel.value || (storageGet(CONDITIONS_KEY) || {}).place || '';
    sel.innerHTML = '<option value="">Kaikki (ei painotusta)</option>' +
      places.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    if (places.includes(current)) sel.value = current;
  }

  // Uudet tiedostot lisätään aiempien joukkoon; samanniminen tiedosto korvaa vanhan.
  function addFiles(files) {
    const merged = new Map(state.files.map((f) => [f.name, f]));
    for (const f of files) merged.set(f.name, f);
    useFiles([...merged.values()]);
  }

  async function initData() {
    try { navigator.storage?.persist?.(); } catch { /* ei tukea */ }
    const stored = await getFiles();
    if (stored && stored.length) useFiles(stored, null, { persist: false });
    if (!('showDirectoryPicker' in window)) {
      $('#pick-dir').hidden = true;
      $('#file-fallback').hidden = false;
      if (!state.dataset) setStatus('Valitse CSV-tiedostot. Ne tallentuvat tälle laitteelle, joten valinta tehdään vain kun data päivittyy.');
      return;
    }
    const handle = await getHandle();
    if (!handle) return;
    state.dirHandle = handle;
    try {
      if ((await handle.queryPermission({ mode: 'read' })) === 'granted') {
        await useDirectory(handle);
        return;
      }
    } catch { /* kahva vanhentunut */ }
    const btn = $('#restore-dir');
    btn.hidden = false;
    btn.textContent = `Avaa tallennettu kansio "${handle.name}"`;
  }

  $('#pick-dir').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ id: 'wax9000', mode: 'read' });
      await saveHandle(handle);
      await useDirectory(handle);
    } catch (e) {
      if (e.name !== 'AbortError') setStatus(`Kansion avaus epäonnistui: ${e.message}`, true);
    }
  });

  $('#restore-dir').addEventListener('click', async () => {
    try {
      if ((await state.dirHandle.requestPermission({ mode: 'read' })) === 'granted') await useDirectory(state.dirHandle);
    } catch (e) {
      setStatus(`Kansion avaus epäonnistui: ${e.message}`, true);
    }
  });

  $('#reload-dir').addEventListener('click', () => state.dirHandle && useDirectory(state.dirHandle));

  $('#pick-files').addEventListener('change', async (e) => {
    const picked = [...e.target.files].filter((f) => f.name.toLowerCase().endsWith('.csv'));
    const files = await Promise.all(
      picked.map(async (f) => ({ name: f.name, lastModified: f.lastModified, text: await f.text() })),
    );
    e.target.value = '';
    if (files.length === 0) {
      setStatus('Valituissa tiedostoissa ei ollut CSV-tiedostoja.', true);
      return;
    }
    addFiles(files);
  });

  $('#clear-data').addEventListener('click', async () => {
    if (!confirm('Poistetaanko tallennettu data tältä laitteelta? Alkuperäisiin CSV-tiedostoihin tämä ei vaikuta.')) return;
    await clearFiles();
    state.files = [];
    state.dataset = null;
    $('#clear-data').hidden = true;
    setStatus('Data poistettu tältä laitteelta.');
    update();
  });

  // ---------- kelisyötteet ----------

  function readConditions() {
    const form = $('#conditions');
    const raw = Object.fromEntries(new FormData(form));
    storageSet(CONDITIONS_KEY, raw);
    const air = parseNum(raw.air);
    const snow = parseNum(raw.snow);
    const humidity = parseNum(raw.humidity);
    const track = parseNum(raw.track);
    const missing = [];
    if (air === null) missing.push('ilma');
    if (snow === null) missing.push('lumi');
    const invalid = [['ilma', air], ['lumi', snow], ['kosteus', humidity], ['ladun kosteus', track]]
      .filter(([, v]) => Number.isNaN(v)).map(([k]) => k);
    if (invalid.length) return { error: `Tarkista luku: ${invalid.join(', ')}` };
    if (missing.length) return { error: `Syötä vielä: ${missing.join(', ')}` };
    // Lumen lämpötila on aina ≤ 0, joten positiivinen luku tulkitaan pakkaseksi
    // (puhelimen numeronäppäimistössä ei ole miinusmerkkiä).
    const cond = { air, snow: -Math.abs(snow) };
    if (humidity !== null) cond.humidity = humidity;
    if (track !== null) cond.track = track;
    if (raw.place) cond.place = raw.place;
    return { cond, warning: snow > 0 ? `Lumi tulkittu: ${fmt(cond.snow)} °C (lumi on aina ≤ 0 °C).` : '' };
  }

  // ±-painike vaihtaa etumerkin, koska iPhonen numeronäppäimistössä ei ole miinusta.
  document.querySelectorAll('#conditions button.sign').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $('#conditions').elements[btn.dataset.for];
      const v = input.value.trim();
      input.value = /^[-−]/.test(v) ? v.slice(1) : `-${v}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });

  function restoreConditions() {
    const saved = storageGet(CONDITIONS_KEY);
    if (!saved) return;
    const form = $('#conditions');
    for (const [k, v] of Object.entries(saved)) if (form.elements[k] && k !== 'place') form.elements[k].value = v;
  }

  let timer;
  $('#conditions').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(update, 200);
  });
  $('#conditions').addEventListener('submit', (e) => { e.preventDefault(); update(); });

  // ---------- asetukset ----------

  function bandLabel(b) {
    if (b.min === null) return `alle ${fmt(b.max, 0)} °C`;
    if (b.max === null) return `yli ${fmt(b.min, 0)} °C`;
    return `${fmt(b.min, 0)} … ${fmt(b.max, 0)} °C`;
  }

  function renderSettings() {
    const s = state.settings;
    const field = (path, label, value, step = '0.1') =>
      `<label>${esc(label)} <input data-path="${path}" type="number" step="${step}" value="${value}"></label>`;
    $('#settings').innerHTML = `
      <fieldset><legend>Ilma, toleranssi ±</legend>
        ${s.airBands.map((b, i) => field(`airBands.${i}.tol`, bandLabel(b), b.tol)).join('')}
      </fieldset>
      <fieldset><legend>Lumi, toleranssi ±</legend>
        ${s.snowBands.map((b, i) => field(`snowBands.${i}.tol`, bandLabel(b), b.tol)).join('')}
      </fieldset>
      <fieldset><legend>Muut toleranssit</legend>
        ${field('humidityTol', 'Kosteus ± %-yks.', s.humidityTol, '1')}
        ${field('trackTol', 'Ladun kosteus ±', s.trackTol, '1')}
      </fieldset>
      <fieldset><legend>Kertoimet</legend>
        ${field('zeroCrossingFactor', 'Nollan ylitys', s.zeroCrossingFactor, '0.05')}
        ${field('missingTrackFactor', 'Ladun kosteus puuttuu', s.missingTrackFactor, '0.05')}
        ${field('placeFactor', 'Sama paikkakunta', s.placeFactor, '0.1')}
      </fieldset>
      <fieldset><legend>Haku</legend>
        ${field('priorWeight', 'Näytön vaatimus (testejä)', s.priorWeight, '0.5')}
        ${field('minTests', 'Laajenna, jos testejä alle', s.minTests, '1')}
        ${field('topN', 'Suosituksia näytetään', s.topN, '1')}
      </fieldset>`;
  }

  $('#settings').addEventListener('input', (e) => {
    const path = e.target.dataset.path;
    const v = parseNum(e.target.value);
    if (!path || v === null || Number.isNaN(v) || v < 0) return;
    const keys = path.split('.');
    let obj = state.settings;
    for (const k of keys.slice(0, -1)) obj = obj[k];
    obj[keys[keys.length - 1]] = v;
    storageSet(SETTINGS_KEY, state.settings);
    clearTimeout(timer);
    timer = setTimeout(update, 200);
  });

  $('#reset-settings').addEventListener('click', () => {
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ei tallennusta */ }
    state.settings = loadSettings();
    renderSettings();
    update();
  });

  // ---------- tulokset ----------

  function recipeHtml(components, highlight = null) {
    return `<ul class="recipe">${components
      .map((c) => `<li><span class="layer">K${esc(c.layer)}</span> <span class="wax${c.wax === highlight ? ' hit' : ''}" title="${esc(c.wax)}">${esc(c.label || c.wax)}</span>${c.method ? ` <span class="method">${esc(c.method)}</span>` : ''}</li>`)
      .join('')}</ul>`;
  }

  function scoreRow(r) {
    return `<div class="score-row">
      <span class="bar"><span style="width:${Math.round(r.score * 100)}%"></span></span>
      <span class="score">${fmt(r.score * 100, 0)}</span>
      <span class="facts">${r.tests} ${r.tests === 1 ? 'testi' : 'testiä'} · ${r.wins} ${r.wins === 1 ? 'voitto' : 'voittoa'}</span>
      ${r.lowEvidence ? '<span class="badge">vähän näyttöä</span>' : ''}
    </div>`;
  }

  function recipeCard(r, rank, highlight = null) {
    return `
      <details class="card">
        <summary>
          <span class="rank">${rank}</span>
          <div class="card-body">
            ${recipeHtml(r.components, highlight)}
            ${scoreRow(r)}
          </div>
        </summary>
        <div class="card-detail">
          ${r.cleaner ? `<p>Voiteenpoisto: <span class="wax">${esc(r.cleaner)}</span></p>` : ''}
          ${matchTable(r.matches)}
        </div>
      </details>`;
  }

  function matchRows(matches, withRecipe = false) {
    return matches.map((m) => `
      <tr>
        <td>${esc(m.date.slice(0, 10))}</td>
        <td>${esc(m.place)}</td>
        <td class="num">${fmt(m.air)}</td>
        <td class="num">${fmt(m.snow)}</td>
        <td class="num">${fmt(m.humidity, 0)}</td>
        <td class="num">${fmt(m.track, 0)}</td>
        ${withRecipe ? `<td>${recipeHtml(m.components)}</td>` : ''}
        <td class="num ${m.placement === 1 ? 'win' : ''}">${m.placement}/${m.fieldSize}</td>
        <td class="num">${fmt(m.weight, 2)}</td>
      </tr>`).join('');
  }

  function matchTable(matches, withRecipe = false) {
    return `<div class="table-wrap"><table>
      <thead><tr><th>Päivä</th><th>Paikka</th><th class="num">Ilma</th><th class="num">Lumi</th><th class="num">Kost.</th><th class="num">Latu</th>
      ${withRecipe ? '<th>Resepti</th>' : ''}<th class="num">Sij.</th><th class="num">Paino</th></tr></thead>
      <tbody>${matchRows(matches, withRecipe)}</tbody></table></div>`;
  }

  function renderResult(el, title, result) {
    const head = `<h2>${esc(title)}</h2>
      <p class="meta">${result.testCount} ${result.testCount === 1 ? 'testi osui' : 'testiä osui'} · ${result.recipes.length} reseptiä</p>
      ${result.widened ? `<p class="notice">Osumia oli vähän, joten haku laajennettiin: toleranssit ×${fmt(result.widenFactor, 2)}.</p>` : ''}`;
    if (result.top.length === 0) {
      el.innerHTML = `${head}<p class="empty">Ei vastaavia testejä.</p>`;
      return;
    }
    const cards = result.top.map((r, i) => recipeCard(r, i + 1)).join('');
    el.innerHTML = `${head}${cards}
      <details class="all">
        <summary>Kaikki osumat (${result.matches.length})</summary>
        ${matchTable(result.matches, true)}
      </details>`;
  }

  function update() {
    const { cond, error, warning } = readConditions();
    $('#form-hint').textContent = state.dataset ? error || warning || '' : 'Lataa ensin data.';
    $('#form-hint').classList.toggle('error', Boolean(error && state.dataset));
    updateProducts(cond);
    if (!state.dataset || !cond) {
      $('#results').hidden = true;
      return;
    }
    const res = WaxCore.recommend(state.dataset, cond, state.settings);
    renderResult($('#glide'), 'Luisto', res.glide);
    renderResult($('#topcoat'), 'Pinta', res.topcoat);
    renderResult($('#pattern'), 'Kuvio', res.pattern);
    $('#results').hidden = false;
    applySections();
  }

  // ---------- näytettävät osiot ----------

  const SECTIONS_KEY = 'wax9000.sections';

  function applySections() {
    const visible = [...document.querySelectorAll('#section-toggles input')].filter((i) => i.checked).map((i) => i.value);
    for (const id of ['glide', 'topcoat', 'pattern']) $('#' + id).hidden = !visible.includes(id);
  }

  function restoreSections() {
    const saved = storageGet(SECTIONS_KEY);
    if (Array.isArray(saved)) {
      for (const i of document.querySelectorAll('#section-toggles input')) i.checked = saved.includes(i.value);
    }
    applySections();
  }

  $('#section-toggles').addEventListener('change', () => {
    storageSet(SECTIONS_KEY, [...document.querySelectorAll('#section-toggles input')].filter((i) => i.checked).map((i) => i.value));
    applySections();
  });

  // ---------- tuotehaku ----------

  function fillBrands(brands) {
    const sel = $('#product-search select[name=brand]');
    const current = sel.value;
    sel.innerHTML = '<option value="">Kaikki merkit</option>' +
      brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
    if (brands.includes(current)) sel.value = current;
    fillProductList();
  }

  function fillProductList() {
    if (!state.dataset) return;
    const form = $('#product-search');
    const kind = form.elements.kind.value;
    const brand = kind === 'pattern' ? '' : form.elements.brand.value;
    $('#brand-field').hidden = kind === 'pattern';
    $('#product-list').innerHTML = state.dataset.stats.products[kind]
      .filter((p) => !brand || p.brand === brand)
      .map((p) => `<option value="${esc(p.label)}">`).join('');
  }

  function updateProducts(cond = readConditions().cond) {
    const form = $('#product-search');
    const hint = $('#product-hint');
    const out = $('#product-results');
    hint.classList.remove('error');
    if (!state.dataset) {
      hint.textContent = 'Lataa ensin data.';
      out.innerHTML = '';
      return;
    }
    const kind = form.elements.kind.value;
    const brand = kind === 'pattern' ? '' : form.elements.brand.value;
    const product = form.elements.product.value;
    const useConditions = form.elements.useConditions.checked;
    if (!brand && !product.trim()) {
      hint.textContent = kind === 'pattern'
        ? 'Kirjoita kuvion nimi (tai osa siitä).'
        : 'Valitse merkki tai kirjoita tuotteen nimi (tai osa siitä).';
      out.innerHTML = '';
      return;
    }
    if (useConditions && !cond) {
      hint.textContent = 'Syötä ilma ja lumi yllä, jotta keli voidaan huomioida.';
      hint.classList.add('error');
      out.innerHTML = '';
      return;
    }
    const res = WaxCore.searchProducts(
      state.dataset,
      { brand, product, kind, conditions: useConditions ? cond : undefined },
      state.settings,
    );
    hint.textContent = `${res.products.length} ${kind === 'pattern' ? (res.products.length === 1 ? 'kuvio' : 'kuviota') : (res.products.length === 1 ? 'tuote' : 'tuotetta')} · ` +
      (useConditions ? `${res.testCount} testiä vastaavalla kelillä` : 'kaikki testit, keli ei vaikuta');
    if (res.products.length === 0) {
      out.innerHTML = '<p class="empty">Ei tuloksia.</p>';
      return;
    }
    out.innerHTML = res.products.map((p, i) => `
      <details class="card product">
        <summary>
          <span class="rank">${i + 1}</span>
          <div class="card-body">
            <div><span class="wax" title="${esc(p.wax)}">${esc(p.label || p.wax)}</span> <span class="method">${kind === 'pattern' ? '' : `${esc(p.brand)} · `}${p.recipes.length} ${p.recipes.length === 1 ? 'resepti' : 'reseptiä'}</span></div>
            ${scoreRow(p)}
          </div>
        </summary>
        <div class="card-detail">
          ${p.recipes.map((r, j) => recipeCard(r, j + 1, p.wax)).join('')}
        </div>
      </details>`).join('');
  }

  let productTimer;
  $('#product-search').addEventListener('input', (e) => {
    if (e.target.name === 'brand' || e.target.name === 'kind') fillProductList();
    clearTimeout(productTimer);
    productTimer = setTimeout(() => updateProducts(), 200);
  });
  $('#product-search').addEventListener('submit', (e) => { e.preventDefault(); updateProducts(); });

  // ---------- käynnistys ----------

  restoreConditions();
  restoreSections();
  renderSettings();
  update();
  initData();

  // Testauskoukku: mahdollistaa datan syötön ilman tiedostovalitsinta.
  window.Wax9000 = { useFiles, addFiles };

  // Offline-tuki: välimuisti toimii vain http(s)-osoitteesta, ei file://-tiedostona.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
