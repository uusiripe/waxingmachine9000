// Waxingmachine9000 – laskentaydin.
// Puhdas JS ilman DOM-riippuvuuksia. Ladataan selaimessa klassisena <script>-tiedostona
// (globaali `WaxCore`) ja Nodessa `require`-kutsulla testejä varten.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WaxCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CLEANER_SUFFIX = '-VOITEENPOISTO';
  const GLIDE_TYPES = ['Luisto', 'Ei arvoa'];
  const TOPCOAT_TYPES = ['Pinta'];

  const COLUMNS = {
    date: 'Date',
    place: 'Place',
    type: 'Test type',
    air: 'Air temperature',
    humidity: 'Relative hum',
    snow: 'Snow temperature',
    track: 'Track',
    ski: 'Ski',
    layer: 'Layer',
    placement: 'Placement',
  };

  // Raporttityypit tunnistetaan otsikkorivistä. `item` on tuote (voide tai kuvio).
  const FILE_KINDS = {
    wax: { item: 'Wax', brand: 'Wax brand', method: 'Application method' },
    pattern: { item: 'Pattern', brand: 'Brand', method: null },
  };

  // Toleranssikaistat: ensimmäinen kaista, jonka [min, max] sisältää syötteen, ratkaisee.
  // null = rajaton. Järjestys on merkitsevä, koska kaistat voivat mennä päällekkäin.
  const DEFAULT_SETTINGS = {
    airBands: [
      { min: -1, max: 1, tol: 0.5 },
      { min: -5, max: 3, tol: 1.5 },
      { min: null, max: -5, tol: 4 },
      { min: 3, max: null, tol: 2 },
    ],
    snowBands: [
      { min: -1, max: null, tol: 0.5 },
      { min: -5, max: -1, tol: 1.5 },
      { min: null, max: -5, tol: 4 },
    ],
    humidityTol: 10,
    trackTol: 10,
    // Eksponentti muuttujan painolle: pienempi = vähemmän vaikutusta. Lumi painaa eniten.
    importance: { snow: 1, air: 0.8, humidity: 0.5, track: 0.5 },
    zeroCrossingFactor: 0.2,
    missingTrackFactor: 0.5,
    placeFactor: 1.5,
    priorWeight: 2,
    priorScore: 0.5,
    minTests: 3,
    widenFactor: 1.5,
    maxWidenSteps: 4,
    topN: 5,
  };

  function num(value) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim().replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  // Pilkuilla eroteltu rivi, jossa kentät voivat olla lainausmerkeissä ("N7,5", "" = ").
  function splitCsvLine(line) {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cell); cell = ''; }
      else cell += ch;
    }
    cells.push(cell);
    return cells;
  }

  // -> { kind: 'wax' | 'pattern' | null, rows }. Tuntematon raportti palauttaa kind = null.
  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length === 0) return { kind: null, rows: [] };
    const header = splitCsvLine(lines[0]).map((h) => h.trim());
    const kind = Object.keys(FILE_KINDS).find((k) => header.includes(FILE_KINDS[k].item)) || null;
    if (!kind) return { kind: null, rows: [] };
    const columns = { ...COLUMNS, item: FILE_KINDS[kind].item, brand: FILE_KINDS[kind].brand };
    if (FILE_KINDS[kind].method) columns.method = FILE_KINDS[kind].method;
    const idx = {};
    for (const [key, name] of Object.entries(columns)) {
      const i = header.indexOf(name);
      if (i === -1) throw new Error(`Sarake puuttuu: ${name}`);
      idx[key] = i;
    }
    const rows = lines.slice(1).map((line) => {
      const cells = splitCsvLine(line);
      const get = (key) => (idx[key] === undefined ? '' : (cells[idx[key]] ?? '').trim());
      return {
        raw: line.trim(),
        kind,
        date: get('date'),
        place: get('place'),
        type: get('type'),
        air: num(get('air')),
        humidity: num(get('humidity')),
        snow: num(get('snow')),
        track: num(get('track')),
        ski: get('ski'),
        wax: get('item'),
        brand: get('brand'),
        layer: num(get('layer')) ?? 0,
        method: get('method'),
        placement: num(get('placement')),
      };
    });
    return { kind, rows };
  }

  function testKey(row) {
    return `${row.kind}|${row.date}|${row.place}|${row.type}`;
  }

  // Kuvioissa merkki on aina sama, joten se jätetään nimestä pois.
  function labelOf(row) {
    const prefix = `${row.brand}-`;
    return row.kind === 'pattern' && row.wax.startsWith(prefix) ? row.wax.slice(prefix.length) : row.wax;
  }

  function buildTest(key, rows) {
    const first = rows[0];
    const bySki = new Map();
    for (const r of rows) {
      if (!bySki.has(r.ski)) bySki.set(r.ski, []);
      bySki.get(r.ski).push(r);
    }
    const skis = [];
    for (const [ski, skiRows] of bySki) {
      const cleaners = skiRows.filter((r) => r.wax.endsWith(CLEANER_SUFFIX)).map((r) => r.wax);
      let parts = skiRows.filter((r) => !r.wax.endsWith(CLEANER_SUFFIX));
      if (parts.length === 0) parts = skiRows; // pelkkä voiteenpoisto: käytetään sitä reseptinä
      // Kerrosnumero riippuu siitä, onko voiteenpoisto kirjattu kerrokseksi 0. Numeroidaan
      // kerrokset uudelleen järjestyksen mukaan, jotta sama resepti tunnistetaan aina samaksi.
      const layers = [...new Set(parts.map((r) => r.layer))].sort((a, b) => a - b);
      const components = parts
        .map((r) => ({ layer: layers.indexOf(r.layer), wax: r.wax, label: labelOf(r), brand: r.brand, method: r.method }))
        .sort((a, b) => a.layer - b.layer || a.wax.localeCompare(b.wax) || a.method.localeCompare(b.method));
      const placement = Math.min(...skiRows.map((r) => r.placement ?? Infinity));
      skis.push({
        ski,
        placement: Number.isFinite(placement) ? placement : null,
        components,
        cleaners: [...new Set(cleaners)],
        recipeKey: components.map((c) => `${c.layer}|${c.wax}|${c.method}`).join(';'),
      });
    }
    // Raportti voi olla brändisuodatettu, jolloin kaikki testin sukset eivät näy.
    const maxPlacement = Math.max(0, ...skis.map((s) => s.placement ?? 0));
    return {
      key,
      kind: first.kind,
      date: first.date,
      place: first.place,
      type: first.type,
      air: first.air,
      humidity: first.humidity,
      snow: first.snow,
      track: first.track,
      fieldSize: Math.max(skis.length, maxPlacement),
      skis,
    };
  }

  // files: [{ name, lastModified, text }]
  function loadReports(files) {
    const ordered = [...files].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name));
    const tests = new Map(); // testin tunniste -> { file, rows }
    let rowCount = 0;
    let duplicatesRemoved = 0;
    const skippedFiles = [];
    for (const file of ordered) {
      const seen = new Set();
      const fileTests = new Map();
      const parsed = parseCsv(file.text);
      if (!parsed.kind) {
        skippedFiles.push(file.name);
        continue;
      }
      for (const row of parsed.rows) {
        rowCount++;
        if (seen.has(row.raw)) {
          duplicatesRemoved++;
          continue;
        }
        seen.add(row.raw);
        const key = testKey(row);
        if (!fileTests.has(key)) fileTests.set(key, []);
        fileTests.get(key).push(row);
      }
      // Uudemman tiedoston versio testistä korvaa vanhan kokonaan.
      for (const [key, rows] of fileTests) tests.set(key, { file: file.name, rows });
    }
    const built = [...tests.entries()].map(([key, t]) => buildTest(key, t.rows));
    built.sort((a, b) => a.date.localeCompare(b.date));
    const keptRows = [...tests.values()].reduce((n, t) => n + t.rows.length, 0);
    const dataset = { tests: built };
    const productsOf = (kind) =>
      [...new Map(allComponents(testsOfKind(dataset, kind)).map((c) => [c.wax, { wax: c.wax, label: c.label, brand: c.brand }])).values()]
        .sort((a, b) => a.wax.localeCompare(b.wax));
    dataset.stats = {
      files: files.length,
      skippedFiles,
      rowsRead: rowCount,
      rows: keptRows,
      duplicatesRemoved,
      tests: built.length,
      waxTests: built.filter((t) => t.kind === 'wax').length,
      patternTests: built.filter((t) => t.kind === 'pattern').length,
      firstDate: built.length ? built[0].date.slice(0, 10) : null,
      lastDate: built.length ? built[built.length - 1].date.slice(0, 10) : null,
      places: [...new Set(built.map((t) => t.place))].sort((a, b) => a.localeCompare(b)),
      brands: [...new Set(allComponents(built.filter((t) => t.kind === 'wax')).map((c) => c.brand))].sort((a, b) => a.localeCompare(b)),
      products: { glide: productsOf('glide'), topcoat: productsOf('topcoat'), pattern: productsOf('pattern') },
    };
    return dataset;
  }

  function allComponents(tests) {
    return tests.flatMap((t) => t.skis.flatMap((s) => s.components));
  }

  function toleranceFor(bands, value) {
    for (const b of bands) {
      if ((b.min === null || value >= b.min) && (b.max === null || value <= b.max)) return b.tol;
    }
    return bands[bands.length - 1].tol;
  }

  function closeness(diff, tol) {
    if (tol <= 0) return diff === 0 ? 1 : 0;
    return Math.max(0, 1 - Math.abs(diff) / tol);
  }

  function testWeight(test, cond, s, widen) {
    if (test.air === null || test.snow === null) return 0;
    const airTol = toleranceFor(s.airBands, cond.air) * widen;
    const snowTol = toleranceFor(s.snowBands, cond.snow) * widen;
    let w =
      closeness(test.air - cond.air, airTol) ** s.importance.air *
      closeness(test.snow - cond.snow, snowTol) ** s.importance.snow;
    if (cond.humidity !== null && cond.humidity !== undefined) {
      if (test.humidity === null) return 0;
      w *= closeness(test.humidity - cond.humidity, s.humidityTol * widen) ** s.importance.humidity;
    }
    if (w === 0) return 0;
    if (cond.track !== null && cond.track !== undefined) {
      if (test.track === null) w *= s.missingTrackFactor;
      else w *= closeness(test.track - cond.track, s.trackTol * widen) ** s.importance.track;
    }
    if (test.air > 0 !== cond.air > 0) w *= s.zeroCrossingFactor;
    if (cond.place && test.place === cond.place) w *= s.placeFactor;
    return w;
  }

  // Pistemäärä painotetuista tuloksista. Vähäinen näyttö vetää pistemäärää kohti keskitasoa:
  // priori on priorWeight täyspainoisen testin verran tulosta priorScore.
  function scoreOf(matches, s) {
    const wsum = matches.reduce((a, m) => a + m.weight, 0);
    const wscore = matches.reduce((a, m) => a + m.weight * m.normalized, 0);
    return {
      score: (wscore + s.priorWeight * s.priorScore) / (wsum + s.priorWeight),
      rawScore: wscore / wsum,
    };
  }

  // weightOf(test) -> testin paino (0 = ei mukana)
  function rankRecipes(tests, weightOf, s) {
    const recipes = new Map();
    const matches = [];
    for (const test of tests) {
      if (test.fieldSize < 2) continue;
      const weight = weightOf(test);
      if (weight <= 0) continue;
      for (const ski of test.skis) {
        if (ski.placement === null) continue;
        const normalized = (test.fieldSize - ski.placement) / (test.fieldSize - 1);
        const match = { test, ski, weight, normalized };
        matches.push(match);
        if (!recipes.has(ski.recipeKey)) {
          recipes.set(ski.recipeKey, { key: ski.recipeKey, components: ski.components, matches: [], cleaners: [] });
        }
        const r = recipes.get(ski.recipeKey);
        r.matches.push(match);
        r.cleaners.push(...ski.cleaners);
      }
    }
    const ranked = [...recipes.values()].map((r) => {
      const testKeys = new Set(r.matches.map((m) => m.test.key));
      const sortedMatches = [...r.matches].sort((a, b) => b.weight - a.weight);
      return {
        key: r.key,
        components: r.components,
        cleaner: mostCommon(r.cleaners),
        ...scoreOf(r.matches, s),
        tests: testKeys.size,
        wins: r.matches.filter((m) => m.ski.placement === 1).length,
        lowEvidence: testKeys.size === 1,
        matches: sortedMatches.map(describeMatch),
      };
    });
    ranked.sort((a, b) => b.score - a.score || b.tests - a.tests || a.key.localeCompare(b.key));
    const testCount = new Set(matches.map((m) => m.test.key)).size;
    return { ranked, matches, testCount };
  }

  function describeMatch(m) {
    const t = m.test;
    return {
      date: t.date,
      place: t.place,
      type: t.type,
      air: t.air,
      snow: t.snow,
      humidity: t.humidity,
      track: t.track,
      ski: m.ski.ski,
      placement: m.ski.placement,
      fieldSize: t.fieldSize,
      weight: m.weight,
    };
  }

  function mostCommon(values) {
    if (values.length === 0) return null;
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  function recommendFor(tests, cond, s) {
    let widen = 1;
    let result = rankRecipes(tests, (t) => testWeight(t, cond, s, widen), s);
    let steps = 0;
    while (result.testCount < s.minTests && steps < s.maxWidenSteps) {
      steps++;
      widen *= s.widenFactor;
      result = rankRecipes(tests, (t) => testWeight(t, cond, s, widen), s);
    }
    return {
      recipes: result.ranked,
      top: result.ranked.slice(0, s.topN),
      testCount: result.testCount,
      widened: steps > 0,
      widenFactor: widen,
      matches: result.matches
        .map((m) => ({ ...describeMatch(m), recipeKey: m.ski.recipeKey, components: m.ski.components, normalized: m.normalized }))
        .sort((a, b) => b.weight - a.weight || a.placement - b.placement),
    };
  }

  function mergeSettings(overrides) {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!overrides) return s;
    for (const [k, v] of Object.entries(overrides)) {
      if (k === 'importance') Object.assign(s.importance, v);
      else if (v !== undefined) s[k] = v;
    }
    return s;
  }

  function normalizeConditions(conditions) {
    for (const k of ['air', 'snow']) {
      if (typeof conditions[k] !== 'number' || !Number.isFinite(conditions[k])) {
        throw new Error(`Puuttuva tai virheellinen syöte: ${k}`);
      }
    }
    return { humidity: null, track: null, place: null, ...conditions };
  }

  // kind: 'glide' (voidetestit Luisto + Ei arvoa), 'topcoat' (voidetestit Pinta),
  // 'pattern' (kaikki kuviotestit, myös Ei arvoa)
  function testsOfKind(dataset, kind) {
    if (kind === 'pattern') return dataset.tests.filter((t) => t.kind === 'pattern');
    const types = kind === 'topcoat' ? TOPCOAT_TYPES : GLIDE_TYPES;
    return dataset.tests.filter((t) => t.kind === 'wax' && types.includes(t.type));
  }

  // conditions: { air, snow, humidity?, track?, place? }
  function recommend(dataset, conditions, settings) {
    const s = mergeSettings(settings);
    const cond = normalizeConditions(conditions);
    return {
      glide: recommendFor(testsOfKind(dataset, 'glide'), cond, s),
      topcoat: recommendFor(testsOfKind(dataset, 'topcoat'), cond, s),
      pattern: recommendFor(testsOfKind(dataset, 'pattern'), cond, s),
    };
  }

  // Tuotehaku: tuotteet, jotka vastaavat merkkiä ja/tai tuotenimen osaa, sekä kaikki reseptit,
  // joissa tuote on mukana.
  // query: { brand?, product?, kind: 'glide' | 'topcoat' | 'pattern', conditions? }
  // Ilman kelitietoja kaikki testit ovat samanarvoisia (paino 1); kelin kanssa painotus on
  // sama kuin suosituksissa, mutta hakua ei laajenneta.
  function searchProducts(dataset, query, settings) {
    const s = mergeSettings(settings);
    const brand = query.brand || null;
    const product = (query.product || '').trim().toLowerCase();
    if (!brand && !product) return { products: [], testCount: 0 };
    const cond = query.conditions ? normalizeConditions(query.conditions) : null;
    const weightOf = cond ? (t) => testWeight(t, cond, s, 1) : () => 1;
    const { ranked, matches, testCount } = rankRecipes(testsOfKind(dataset, query.kind), weightOf, s);
    const isHit = (c) => (!brand || c.brand === brand) && (!product || c.wax.toLowerCase().includes(product));

    const byWax = new Map();
    for (const m of matches) {
      for (const wax of new Set(m.ski.components.filter(isHit).map((c) => c.wax))) {
        if (!byWax.has(wax)) {
          const c = m.ski.components.find((x) => x.wax === wax);
          byWax.set(wax, { wax, label: c.label, brand: c.brand, matches: [] });
        }
        byWax.get(wax).matches.push(m);
      }
    }
    const products = [...byWax.values()].map((p) => {
      const testKeys = new Set(p.matches.map((m) => m.test.key));
      return {
        wax: p.wax,
        label: p.label,
        brand: p.brand,
        ...scoreOf(p.matches, s),
        tests: testKeys.size,
        wins: p.matches.filter((m) => m.ski.placement === 1).length,
        lowEvidence: testKeys.size === 1,
        recipes: ranked.filter((r) => r.components.some((c) => c.wax === p.wax)),
      };
    });
    products.sort((a, b) => b.score - a.score || b.tests - a.tests || a.wax.localeCompare(b.wax));
    return { products, testCount };
  }

  return { loadReports, recommend, searchProducts, DEFAULT_SETTINGS, toleranceFor };
});
