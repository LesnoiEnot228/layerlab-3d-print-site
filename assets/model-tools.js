(function () {
'use strict';
/* LayerLab local mesh analysis and internal model-request helper.
   Model files are parsed in the browser and are not uploaded.
   Temporary retail rates below must be replaced before launch; use server-side pricing for confidentiality. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const i18n = {
  ru: {
    searchEmptyQuery: 'Введи название или описание модели.',
    searchGenerated: 'Запрос добавлен к заявке ниже. Поиск не открывает сторонние сайты.',
    searchSummary: 'Запрос модели: ',
    analyzing: 'Анализируем…', ready: 'Анализ готов', failed: 'Ошибка анализа', largeFile: 'Файл больше 30 МБ. Выбери файл меньшего размера.',
    unsupported: 'Не удалось прочитать файл. Попробуй экспортировать его в STL из слайсера.',
    badDimensions: 'Размеры выглядят необычно. Проверь единицы STL / OBJ.',
    noEstimate: 'Не получилось надёжно оценить объём сетки. Проверь файл в слайсере — цена будет подтверждена вручную.',
    dims: 'Габариты', triangles: 'треугольников', weight: 'Оценка пластика', time: 'Оценка времени печати',
    price: 'Предварительная оценка', priceNote: 'Геометрическая оценка с тестовыми расценками; это не результат слайсера. Итоговую цену подтвердим вручную.',
    needsReview: 'Нужна ручная проверка',
    analysisEstimateCaution: 'Оценка приблизительная: реальный расход и время зависят от профиля слайсера, стенок, поддержек и ориентации. Используются тестовые расценки, их нужно заменить до публикации.',
    estimateBeforeAnalysis: 'Выбери STL, 3MF или OBJ — анализ начнётся в браузере.',
    volumeWarning: 'Объём может быть неточным для открытой, самопересекающейся или повреждённой сетки.',
    sizeWarning: 'Модель может выходить за область печати Ender 3 Pro (около 220 × 220 × 250 мм). Возможно, потребуется изменить ориентацию или разделить модель.',
    sizeOkay: 'Габариты по отдельным осям укладываются в номинальную область печати принтера; ориентацию и поддержки всё равно нужно проверить.',
    unitHint: 'STL и OBJ обычно не содержат единиц измерения — размеры рассчитаны с выбранным масштабом.',
    multi3mfWarning: '3MF может содержать сборку из нескольких объектов и трансформации. Проверь, что предпросмотр соответствует всей модели.',
    estimated: 'Оценка'
  },
  en: {
    searchEmptyQuery: 'Enter a model name or description.',
    searchGenerated: 'The request has been added below. No external sites are opened.',
    searchSummary: 'Model request: ',
    analyzing: 'Analysing…', ready: 'Analysis ready', failed: 'Analysis error', largeFile: 'The file exceeds 30 MB. Please choose a smaller file.',
    unsupported: 'Could not read this file. Try exporting it to STL from your slicer.',
    badDimensions: 'The dimensions look unusual. Check STL / OBJ units.',
    noEstimate: 'Could not reliably estimate the mesh volume. Check the file in a slicer; the price will be confirmed manually.',
    dims: 'Dimensions', triangles: 'triangles', weight: 'Estimated filament', time: 'Estimated print time',
    price: 'Preliminary estimate', priceNote: 'Geometry-based estimate with temporary rates; it is not slicer output. The final price will be confirmed manually.',
    needsReview: 'Manual review needed',
    analysisEstimateCaution: 'Estimate only: actual material use and time depend on the slicer profile, walls, supports and orientation. Temporary rates must be replaced before launch.',
    estimateBeforeAnalysis: 'Choose an STL, 3MF or OBJ file. Analysis runs in your browser.',
    volumeWarning: 'Volume may be inaccurate for open, self-intersecting, or damaged meshes.',
    sizeWarning: 'The model may exceed the Ender 3 Pro build volume (about 220 × 220 × 250 mm). It may need reorientation or splitting.',
    sizeOkay: 'Each dimension is within the nominal printer build volume; orientation and supports still need checking.',
    unitHint: 'STL and OBJ usually do not define units. Dimensions use the selected scale.',
    multi3mfWarning: 'A 3MF may contain multiple objects and transforms. Check whether the preview represents the full model.',
    estimated: 'Estimate'
  }
};
let language = document.documentElement.lang === 'en' ? 'en' : 'ru';
const tr = key => (i18n[language] && i18n[language][key]) || i18n.ru[key] || key;

// Cross-catalogue search links. These open the catalogues directly; the user downloads the model and uploads it in the order form.
const searchInput = $('#modelSearchInput');
const searchButton = $('#modelSearchButton');
const searchResults = $('#modelSearchResults');
const searchHelp = $('#modelSearchHelp');
let lastQuery = '';
const searchUrlBuilders = {
  thingiverse: q => `https://www.thingiverse.com/search?type=things${q ? `&q=${encodeURIComponent(q)}` : ''}`,
  printables: q => `https://www.printables.com/search/models${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  cults: q => `https://cults3d.com/en/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
  myminifactory: q => `https://www.myminifactory.com/search/${q ? `?query=${encodeURIComponent(q)}` : ''}`,
  makerworld: q => `https://makerworld.com/en/search/models${q ? `?keyword=${encodeURIComponent(q)}` : ''}`
};
function updateModelSearchLinks(showStatus = false) {
  const query = searchInput?.value.trim() || '';
  lastQuery = query;
  $$('.model-source-link[data-model-site]').forEach(link => {
    const builder = searchUrlBuilders[link.dataset.modelSite];
    if (builder) link.href = builder(query);
  });
  if (showStatus && searchResults) {
    searchResults.hidden = false;
    searchResults.textContent = language === 'ru'
      ? (query ? `Поиск «${query}» подготовлен. Выбери площадку выше; после скачивания прикрепи модель к заявке.` : 'Выбери площадку выше. Можно открыть каталог без поискового запроса.')
      : (query ? `Search for “${query}” is ready. Choose a catalogue above; upload the downloaded model to your order.` : 'Choose a catalogue above. You can open a catalogue without a search term.');
  }
}
if (searchInput) searchInput.addEventListener('input', () => updateModelSearchLinks(false));
if (searchButton) searchButton.addEventListener('click', () => updateModelSearchLinks(true));
updateModelSearchLinks(false);

// Local parsers. The model never leaves the visitor's browser.
const MAX_TRIANGLES = 450_000;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
let parsedModel = null;
let latestMetrics = null;
let activeFileName = '';
let rotationX = -0.48;
let rotationY = 0.6;
let zoom = 1;
let pointerStart = null;
let previewPositions = null;
let previewMetrics = null;

function parseStl(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength >= 84) {
    const count = view.getUint32(80, true);
    if (count > 0 && count <= MAX_TRIANGLES && 84 + count * 50 === buffer.byteLength) {
      const positions = new Float32Array(count * 9);
      let p = 0;
      for (let i = 0; i < count; i++) {
        const base = 84 + i * 50 + 12; // Skip the 12-byte facet normal.
        for (let v = 0; v < 9; v++, p++) positions[p] = view.getFloat32(base + v * 4, true);
      }
      return { positions, format: 'STL', is3mf: false, unitScale: 1 };
    }
  }
  const text = new TextDecoder().decode(buffer);
  const regex = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/gi;
  const values = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
    if (values.length >= MAX_TRIANGLES * 9) throw new Error('triangle-limit');
  }
  const length = Math.floor(values.length / 9) * 9;
  if (length < 9) throw new Error('invalid-stl');
  return { positions: Float32Array.from(values.slice(0, length)), format: 'STL', is3mf: false, unitScale: 1 };
}

function parseObj(buffer) {
  const text = new TextDecoder().decode(buffer);
  const vertices = [];
  const positions = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^v\s/.test(line)) {
      const parts = line.split(/\s+/);
      const x = Number(parts[1]), y = Number(parts[2]), z = Number(parts[3]);
      if ([x, y, z].every(Number.isFinite)) vertices.push([x, y, z]);
    } else if (/^f\s/.test(line)) {
      const indices = line.split(/\s+/).slice(1).map(token => {
        const raw = Number.parseInt(token.split('/')[0], 10);
        if (!Number.isFinite(raw) || raw === 0) return -1;
        return raw > 0 ? raw - 1 : vertices.length + raw;
      });
      if (indices.length < 3 || indices.some(index => index < 0 || index >= vertices.length)) continue;
      for (let i = 1; i < indices.length - 1; i++) {
        const triangle = [vertices[indices[0]], vertices[indices[i]], vertices[indices[i + 1]]];
        for (const vertex of triangle) positions.push(vertex[0], vertex[1], vertex[2]);
        if (positions.length / 9 > MAX_TRIANGLES) throw new Error('triangle-limit');
      }
    }
  }
  if (positions.length < 9) throw new Error('invalid-obj');
  return { positions: Float32Array.from(positions), format: 'OBJ', is3mf: false, unitScale: 1 };
}

async function inflateRaw(compressed) {
  if (typeof DecompressionStream === 'undefined') throw new Error('zip-decompression-unavailable');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 50 * 1024 * 1024) { await reader.cancel(); throw new Error('3mf-uncompressed-too-large'); }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}

async function getZipEntry(buffer, wantedNames) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  let eocd = -1;
  const start = Math.max(0, buffer.byteLength - 65_557);
  for (let i = buffer.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('invalid-zip');
  const entryCount = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const wanted = new Set(wantedNames.map(name => name.toLowerCase()));
  let best = null;
  for (let i = 0; i < entryCount; i++) {
    if (ptr + 46 > buffer.byteLength || view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.slice(ptr + 46, ptr + 46 + nameLen));
    if (name.toLowerCase().endsWith('.model')) {
      if (!best || wanted.has(name.toLowerCase()) || /3dmodel\.model$/i.test(name)) best = { name, method, compressedSize, localOffset };
      if (wanted.has(name.toLowerCase()) || /(^|\/)3dmodel\.model$/i.test(name)) {
        // Prefer the canonical model part if present.
        if (/^3d\/3dmodel\.model$/i.test(name) || wanted.has(name.toLowerCase())) break;
      }
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  if (!best) throw new Error('no-3mf-model');
  const lo = best.localOffset;
  if (view.getUint32(lo, true) !== 0x04034b50) throw new Error('invalid-zip-entry');
  const localNameLen = view.getUint16(lo + 26, true);
  const localExtraLen = view.getUint16(lo + 28, true);
  const dataStart = lo + 30 + localNameLen + localExtraLen;
  const compressed = buffer.slice(dataStart, dataStart + best.compressedSize);
  let result;
  if (best.method === 0) result = compressed;
  else if (best.method === 8) result = await inflateRaw(compressed);
  else throw new Error('unsupported-zip-compression');
  return { buffer: result, path: best.name };
}

function localNameElements(documentNode, name) {
  return Array.from(documentNode.getElementsByTagName('*')).filter(node => node.localName === name);
}

async function parse3mf(buffer) {
  const entry = await getZipEntry(buffer, ['3d/3dmodel.model']);
  const xmlText = new TextDecoder().decode(entry.buffer);
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('invalid-3mf-xml');
  const rootModel = localNameElements(xml, 'model')[0];
  const unit = (rootModel?.getAttribute('unit') || 'millimeter').toLowerCase();
  const unitScales = { millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, micrometer: 0.001, meter: 1000 };
  const unitScale = unitScales[unit] ?? 1;
  const objects = localNameElements(xml, 'object');
  const objectMeshes = [];
  for (const object of objects) {
    const mesh = Array.from(object.getElementsByTagName('*')).find(node => node.localName === 'mesh');
    if (!mesh) continue;
    const vertexNodes = Array.from(mesh.getElementsByTagName('*')).filter(node => node.localName === 'vertex');
    const triangleNodes = Array.from(mesh.getElementsByTagName('*')).filter(node => node.localName === 'triangle');
    if (!vertexNodes.length || !triangleNodes.length) continue;
    objectMeshes.push({ vertexNodes, triangleNodes, objectId: object.getAttribute('id') });
  }
  if (!objectMeshes.length) throw new Error('no-3mf-mesh');
  // This first implementation reads mesh geometry from the first object. Complex assemblies
  // may require transforms/components from the 3MF build graph and are marked for manual review.
  const mesh = objectMeshes[0];
  if (mesh.triangleNodes.length > MAX_TRIANGLES) throw new Error('triangle-limit');
  const vertices = mesh.vertexNodes.map(node => [
    Number(node.getAttribute('x')) * unitScale,
    Number(node.getAttribute('y')) * unitScale,
    Number(node.getAttribute('z')) * unitScale
  ]);
  const positions = new Float32Array(mesh.triangleNodes.length * 9);
  let p = 0;
  for (const tri of mesh.triangleNodes) {
    const ids = ['v1', 'v2', 'v3'].map(key => Number(tri.getAttribute(key)));
    if (ids.some(id => !Number.isInteger(id) || id < 0 || id >= vertices.length)) continue;
    for (const id of ids) {
      const v = vertices[id];
      positions[p++] = v[0]; positions[p++] = v[1]; positions[p++] = v[2];
    }
  }
  if (p < 9) throw new Error('invalid-3mf-triangles');
  return { positions: positions.slice(0, p), format: '3MF', is3mf: true, unitScale: 1, multipleObjects: objectMeshes.length > 1 };
}

async function readModel(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('file-too-large');
  const ext = file.name.split('.').pop().toLowerCase();
  const buffer = await file.arrayBuffer();
  if (ext === 'stl') return parseStl(buffer);
  if (ext === 'obj') return parseObj(buffer);
  if (ext === '3mf') return await parse3mf(buffer);
  throw new Error('unsupported-file');
}

function analyseGeometry(rawPositions, scale = 1) {
  const positions = new Float32Array(rawPositions.length);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let surface = 0, signedVolume = 0;
  for (let i = 0; i < rawPositions.length; i += 3) {
    const x = rawPositions[i] * scale;
    const y = rawPositions[i + 1] * scale;
    const z = rawPositions[i + 2] * scale;
    positions[i] = x; positions[i + 1] = y; positions[i + 2] = z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    surface += Math.hypot(nx, ny, nz) / 2;
    signedVolume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  const x = maxX - minX, y = maxY - minY, z = maxZ - minZ;
  const bboxVolume = x * y * z;
  const volume = Math.abs(signedVolume);
  const volumeRatio = bboxVolume > 0 ? volume / bboxVolume : 0;
  const validDims = [x, y, z].every(n => Number.isFinite(n) && n > 0.001 && n < 100_000);
  const volumeReliable = validDims && Number.isFinite(volume) && volume > bboxVolume * 1e-7 && volume <= bboxVolume * 1.15;
  if (!validDims) throw new Error('invalid-dimensions');
  return {
    positions, triangleCount: positions.length / 9,
    min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
    dimensions: [x, y, z], surfaceMm2: surface, volumeMm3: volume,
    volumeReliable, volumeRatio,
    bboxVolumeMm3: bboxVolume
  };
}

function calculateEstimate(metrics) {
  if (!metrics || !metrics.volumeReliable) return null;
  const infill = Number($('#modelInfill')?.value || 15) / 100;
  const layerHeight = Number($('#modelLayer')?.value || 0.2);
  const materialName = $('#material')?.value || 'PLA';
  const qtyVal = $('#quantity')?.value || '1';
  const quantity = qtyVal === '10+' ? 10 : Math.max(1, Number(qtyVal) || 1);
  const material = PRICING.materials[materialName] || PRICING.materials.PLA;
  const volume = metrics.volumeMm3;
  const surface = metrics.surfaceMm2;
  // FDM shell + infill approximation. Actual slicer output varies with orientation,
  // top/bottom layers, wall count, support structures and the profile.
  const shellVolume = Math.min(volume, surface * PRICING.wallThicknessMm);
  const interiorVolume = Math.max(0, volume - shellVolume);
  const filamentVolume = shellVolume + interiorVolume * infill;
  const grams = filamentVolume / 1000 * material.density;
  const layerCount = Math.max(1, Math.ceil(metrics.dimensions[2] / layerHeight));
  const extrusionSeconds = filamentVolume / PRICING.flowRateMm3s;
  const estimatedHours = Math.max(0.12, (extrusionSeconds * PRICING.timeMultiplier + layerCount * PRICING.secondsPerLayer + 240) / 3600);
  const costFor = (g, h) => {
    const plasticCost = material.pricePerKg * g / 1000;
    const electricityCost = (PRICING.printerPowerW / 1000) * h * PRICING.electricityPerKWh;
    const wearCost = h * PRICING.amortizationPerHour;
    return plasticCost + electricityCost + wearCost;
  };
  const retail = cost => {
    let factor;
    if (cost <= 10) factor = 2.5;
    else if (cost <= 25) factor = 2.0;
    else if (cost <= 50) factor = 1.7;
    else factor = 1.5;
    return Math.max(PRICING.minimumOrder, cost * factor);
  };
  const low = retail(costFor(grams * 0.78, estimatedHours * 0.72)) * quantity;
  const high = retail(costFor(grams * 1.28, estimatedHours * 1.38)) * quantity;
  const round = value => Math.ceil(value * 2) / 2;
  return {
    grams, estimatedHours, material: materialName, quantity,
    low: round(Math.min(low, high)), high: round(Math.max(low, high)),
    filamentVolumeMm3: filamentVolume, layerCount
  };
}

// DEMO-only assumptions: replace with real spool prices before launch.
// These do not appear as markup percentages in the customer-facing UI, but client-side
// JavaScript can be inspected. Move this whole calculation server-side to protect it.
const PRICING = {
  materials: {
    PLA: { pricePerKg: 45, density: 1.24 },
    PETG: { pricePerKg: 55, density: 1.27 }
  },
  electricityPerKWh: 0.25,
  printerPowerW: 360,
  amortizationPerHour: 0.2,
  wallThicknessMm: 1.2,
  flowRateMm3s: 4.5,
  timeMultiplier: 1.65,
  secondsPerLayer: 2.1,
  minimumOrder: 5
};

function formatBYN(value) {
  const number = new Intl.NumberFormat(language === 'ru' ? 'ru-RU' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  return `${number} BYN`;
}
function formatHours(hours) {
  const mins = Math.max(1, Math.round(hours * 60));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (language === 'ru') return h ? `${h} ч ${m ? `${m} мин` : ''}`.trim() : `${h} h ${m ? `${m} min` : ''}`.trim();
  return h ? `${h} h ${m ? `${m} min` : ''}`.trim() : `${m} min`;
}
function formatNumber(value, decimals = 1) {
  return new Intl.NumberFormat(language === 'ru' ? 'ru-RU' : 'en-GB', { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(value);
}

function drawModel(metrics) {
  const canvas = $('#modelCanvas');
  if (!canvas || !metrics) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cssW = Math.max(260, canvas.clientWidth || 320);
  const cssH = Math.max(220, canvas.clientHeight || 265);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const centerX = (metrics.min[0] + metrics.max[0]) / 2;
  const centerY = (metrics.min[1] + metrics.max[1]) / 2;
  const centerZ = (metrics.min[2] + metrics.max[2]) / 2;
  const maxDim = Math.max(...metrics.dimensions, 1);
  const scale = (Math.min(cssW, cssH) * 0.67 / maxDim) * zoom;
  const cosY = Math.cos(rotationY), sinY = Math.sin(rotationY);
  const cosX = Math.cos(rotationX), sinX = Math.sin(rotationX);
  const transformed = new Float32Array(metrics.positions.length);
  for (let i = 0; i < metrics.positions.length; i += 3) {
    const x = metrics.positions[i] - centerX;
    const y = metrics.positions[i + 1] - centerY;
    const z = metrics.positions[i + 2] - centerZ;
    const rx = x * cosY + z * sinY;
    const rz = -x * sinY + z * cosY;
    const ry = y * cosX - rz * sinX;
    const rz2 = y * sinX + rz * cosX;
    transformed[i] = cssW / 2 + rx * scale;
    transformed[i + 1] = cssH / 2 - ry * scale;
    transformed[i + 2] = rz2;
  }
  // A subtle floor grid helps communicate scale without pretending to be a slicer preview.
  ctx.save();
  ctx.strokeStyle = 'rgba(148,240,210,.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = cssH * 0.73 + i * 10;
    ctx.beginPath(); ctx.moveTo(cssW * 0.14 + i * 3, y); ctx.lineTo(cssW * 0.86 - i * 3, y); ctx.stroke();
  }
  ctx.restore();
  const total = metrics.triangleCount;
  const stride = Math.max(1, Math.ceil(total / 3600));
  const faces = [];
  for (let t = 0; t < total; t += stride) {
    const i = t * 9;
    const ax = transformed[i], ay = transformed[i + 1], az = transformed[i + 2];
    const bx = transformed[i + 3], by = transformed[i + 4], bz = transformed[i + 5];
    const cx = transformed[i + 6], cy = transformed[i + 7], cz = transformed[i + 8];
    if (![ax,ay,az,bx,by,bz,cx,cy,cz].every(Number.isFinite)) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const light = Math.abs((nx * -0.36 + ny * 0.72 + nz * 0.59) / nl);
    faces.push({ ax, ay, az, bx, by, bz, cx, cy, cz, z: (az + bz + cz) / 3, light });
  }
  faces.sort((a, b) => a.z - b.z);
  for (const f of faces) {
    const light = 0.16 + f.light * 0.38;
    const green = Math.round(135 + f.light * 80);
    const blue = Math.round(155 + f.light * 75);
    ctx.beginPath(); ctx.moveTo(f.ax, f.ay); ctx.lineTo(f.bx, f.by); ctx.lineTo(f.cx, f.cy); ctx.closePath();
    ctx.fillStyle = `rgba(102,${green},${blue},${light})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,245,231,.16)'; ctx.lineWidth = 0.45; ctx.stroke();
  }
}

function setAnalysisStatus(state, text) {
  const el = $('#analysisStatus');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = text;
}

function setAnalysisError(error) {
  const panel = $('#modelAnalysis');
  if (panel) panel.hidden = false;
  setAnalysisStatus('error', error === 'invalid-dimensions' ? tr('badDimensions') : tr('failed'));
  const canvas = $('#modelCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 260;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#8c9aaa'; ctx.font = '14px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(tr('unsupported'), w/2, h/2, w - 30);
  }
  $('#modelDimensions').textContent = '—';
  $('#modelTriangles').textContent = '—';
  $('#modelSurface').textContent = '—';
  $('#modelVolume').textContent = '—';
  $('#modelWeight').textContent = '—';
  $('#modelTime').textContent = '—';
  $('#modelEstimateRange').textContent = tr('needsReview');
  $('#estimateRange').textContent = tr('needsReview');
  $('#estimateText').textContent = tr('noEstimate');
  $('#modelEstimateNote').textContent = tr('noEstimate');
  $('#analysisWarning').textContent = tr('noEstimate');
}

function refreshEstimate() {
  if (!latestMetrics) return;
  const estimate = calculateEstimate(latestMetrics);
  const mat = $('#material')?.value || 'PLA';
  const qty = $('#quantity')?.value || '1';
  const modelInfo = `${formatNumber(latestMetrics.dimensions[0])} × ${formatNumber(latestMetrics.dimensions[1])} × ${formatNumber(latestMetrics.dimensions[2])} mm`;
  $('#modelDimensions').textContent = modelInfo;
  $('#modelTriangles').textContent = Math.round(latestMetrics.triangleCount).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB');
  $('#modelSurface').textContent = formatNumber(latestMetrics.surfaceMm2 / 100, 2);
  $('#modelVolume').textContent = latestMetrics.volumeReliable ? formatNumber(latestMetrics.volumeMm3 / 1000, 2) : '—';
  drawModel(latestMetrics);
  if (!estimate) {
    $('#modelWeight').textContent = '—';
    $('#modelTime').textContent = '—';
    $('#modelEstimateRange').textContent = tr('needsReview');
    $('#estimateRange').textContent = tr('needsReview');
    $('#estimateText').textContent = tr('noEstimate');
    $('#modelEstimateNote').textContent = tr('noEstimate');
    $('#analysisWarning').textContent = `${tr('volumeWarning')} ${tr('analysisEstimateCaution')}`;
    return;
  }
  $('#modelWeight').textContent = `${formatNumber(estimate.grams, 1)} g`;
  $('#modelTime').textContent = formatHours(estimate.estimatedHours);
  const range = estimate.low === estimate.high
    ? `${language === 'ru' ? 'от ' : 'from '}${formatBYN(estimate.low)}`
    : `${formatBYN(estimate.low)} – ${formatBYN(estimate.high)}`;
  $('#modelEstimateRange').textContent = range;
  $('#estimateRange').textContent = range;
  $('#estimateText').textContent = tr('priceNote');
  $('#modelEstimateNote').textContent = `${tr('priceNote')} ${tr('estimated')}: ${qty} × ${mat}.`;
  const oversized = latestMetrics.dimensions[0] > 220 || latestMetrics.dimensions[1] > 220 || latestMetrics.dimensions[2] > 250;
  const warnings = [];
  if (!latestMetrics.volumeReliable || latestMetrics.volumeRatio < 0.01) warnings.push(tr('volumeWarning'));
  if (oversized) warnings.push(tr('sizeWarning'));
  else warnings.push(tr('sizeOkay'));
  if (parsedModel?.is3mf && parsedModel?.multipleObjects) warnings.push(tr('multi3mfWarning'));
  if (!parsedModel?.is3mf) warnings.push(tr('unitHint'));
  warnings.push(tr('analysisEstimateCaution'));
  $('#analysisWarning').textContent = warnings.join(' ');
}

async function loadAndAnalyse(file) {
  activeFileName = file.name;
  parsedModel = null;
  latestMetrics = null;
  const panel = $('#modelAnalysis');
  if (panel) panel.hidden = false;
  if (file.size > 30 * 1024 * 1024) {
    setAnalysisStatus('error', tr('failed'));
    $('#analysisWarning').textContent = tr('largeFile');
    $('#estimateText').textContent = tr('largeFile');
    $('#estimateRange').textContent = tr('needsReview');
    $('#modelEstimateRange').textContent = tr('needsReview');
    return;
  }
  setAnalysisStatus('working', tr('analyzing'));
  $('#modelDimensions').textContent = '…';
  $('#modelTriangles').textContent = '…';
  $('#modelSurface').textContent = '…';
  $('#modelVolume').textContent = '…';
  $('#modelEstimateRange').textContent = '…';
  $('#estimateRange').textContent = '…';
  $('#estimateText').textContent = tr('analyzing');
  try {
    const result = await readModel(file);
    if (activeFileName !== file.name) return;
    parsedModel = result;
    const unitsField = $('#unitsField');
    if (unitsField) unitsField.hidden = result.is3mf;
    const unitSelect = $('#modelUnits');
    if (unitSelect) unitSelect.value = '1';
    const scale = result.is3mf ? 1 : Number(unitSelect?.value || 1);
    latestMetrics = analyseGeometry(result.positions, scale);
    if (!latestMetrics.volumeReliable || latestMetrics.volumeRatio < 0.01) {
      // Keep measurable dimensions and preview, but mark volume-based price as unreliable.
      setAnalysisStatus('ready', tr('ready'));
      refreshEstimate();
      return;
    }
    setAnalysisStatus('ready', tr('ready'));
    refreshEstimate();
  } catch (error) {
    console.warn('LayerLab model analysis error:', error);
    if (activeFileName !== file.name) return;
    setAnalysisError(error?.message || String(error));
  }
}

function clearAnalysis() {
  parsedModel = null;
  latestMetrics = null;
  activeFileName = '';
  const panel = $('#modelAnalysis'); if (panel) panel.hidden = true;
  $('#modelEstimateRange').textContent = '—';
  $('#estimateRange').textContent = language === 'ru' ? 'Нужна оценка' : 'Needs review';
  $('#estimateText').textContent = tr('estimateBeforeAnalysis');
}

const fileInput = $('#modelFile');
if (fileInput) fileInput.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) loadAndAnalyse(file);
});
$('#fileStatus')?.addEventListener('click', event => {
  if (event.target.closest('button')) clearAnalysis();
});
window.addEventListener('model-file-cleared', clearAnalysis);
['#modelInfill', '#modelLayer', '#modelUnits', '#material', '#quantity'].forEach(selector => {
  $(selector)?.addEventListener('change', () => {
    if (!parsedModel) return;
    if (selector === '#modelUnits' && !parsedModel.is3mf) {
      latestMetrics = analyseGeometry(parsedModel.positions, Number($('#modelUnits').value || 1));
    }
    refreshEstimate();
  });
});
$('#resetModelView')?.addEventListener('click', () => { rotationX = -0.48; rotationY = 0.6; zoom = 1; if (latestMetrics) drawModel(latestMetrics); });
const canvas = $('#modelCanvas');
if (canvas) {
  canvas.addEventListener('pointerdown', event => { pointerStart = { x: event.clientX, y: event.clientY, rx: rotationX, ry: rotationY }; canvas.setPointerCapture?.(event.pointerId); });
  canvas.addEventListener('pointermove', event => {
    if (!pointerStart || !latestMetrics) return;
    rotationY = pointerStart.ry + (event.clientX - pointerStart.x) * 0.012;
    rotationX = Math.max(-1.5, Math.min(1.5, pointerStart.rx + (event.clientY - pointerStart.y) * 0.009));
    drawModel(latestMetrics);
  });
  const endDrag = () => { pointerStart = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('wheel', event => {
    if (!latestMetrics) return;
    event.preventDefault(); zoom = Math.max(0.55, Math.min(2.5, zoom * (event.deltaY < 0 ? 1.08 : 0.92))); drawModel(latestMetrics);
  }, { passive: false });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (latestMetrics) drawModel(latestMetrics); }).observe(canvas);
}

window.addEventListener('site-language-change', event => {
  language = event.detail?.lang === 'en' ? 'en' : 'ru';
  updateModelSearchLinks(false);
  if (latestMetrics) refreshEstimate();
  else if ($('#estimateRange')) {
    $('#estimateRange').textContent = language === 'ru' ? 'Нужна оценка' : 'Needs review';
    $('#estimateText').textContent = tr('estimateBeforeAnalysis');
  }
  if ($('#analysisStatus') && !latestMetrics && $('#modelAnalysis') && !$('#modelAnalysis').hidden) setAnalysisStatus('idle', tr('unsupported'));
});

// Make initial estimate copy consistent with the chosen interface language.
if ($('#estimateText')) $('#estimateText').textContent = tr('estimateBeforeAnalysis');

})();
