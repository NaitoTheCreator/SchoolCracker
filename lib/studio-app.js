import * as pdfjsLib from '/vendor/pdf.min.mjs';
import {
  PAGE_W,
  PAGE_H,
  getGlyphHorizontalMetrics,
  computeTextPages,
  layoutBoxText,
  hitTestStroke,
  hitTestTextBox,
  findFlowWordAtPoint,
  removeWordRangeFromText,
} from './layout.js';
import { buildNotabilityPdf } from './pdf-builder.js';
import { buildHandwritingTtf, buildIosFontMobileConfig } from './font-builder.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';

const STORAGE_GLYPHS = 'schoolfucker_glyphs_v1';
const STORAGE_NOTEBOOKS = 'schoolfucker_notebooks_v1';
const CHAR_SET = 'abcdefghijklmnopqrstuvwxyzäöüßABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789.,!?-+=/():;'.split('');

function makeSheet(overrides = {}) {
  return {
    id: 'sheet-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    paperOverride: 'inherit',
    importedPageIndex: null,
    importedPreviewDataUrl: null,
    importedPreviewImg: null,
    customBgDataUrl: null,
    customBgImage: null,
    textBoxes: [],
    strokes: [],
    whiteoutStrokes: [],
    ...overrides,
  };
}

const state = {
  text: '',
  font: 'my-script',
  paper: 'grid',
  title: 'Mein Heft',
  inkColor: '#1e3a8a',
  fontSize: 34,
  lineHeight: 46,
  letterSpacing: 0,
  margin: 64,
  customBgDataUrl: null,
  customBgImage: null,
  basePdfBytes: null,
  basePdfName: null,
  currentPage: 0,
  seedOffset: 1,
  glyphs: {},
  notebooks: [],
  activeChar: 'a',
  sheets: [makeSheet()],
  canvasTool: 'select', // 'select' | 'textbox' | 'pen' | 'eraser'
  selectedBoxId: null,
  exportMode: 'notability-editable',
  editableTextFields: false,
};

let cachedFlowPages = [];
let sheetUndoStack = [];

let measureCtx = null;
const charWidthCache = new Map();
function measureCharWidth(ch, fontName, fontSize) {
  if (!ch) return fontSize * 0.28;
  const family = fontName === 'patrick' ? '"Patrick Hand", cursive' : '"Caveat", cursive';
  const key = `${family}|${fontSize}|${ch}`;
  if (charWidthCache.has(key)) return charWidthCache.get(key);
  if (!measureCtx) {
    const c = document.createElement('canvas');
    measureCtx = c.getContext('2d');
  }
  measureCtx.font = `${fontSize}px ${family}`;
  const width = measureCtx.measureText(ch).width;
  charWidthCache.set(key, width);
  return width;
}

// Canvas interaction state for sheet editor
let previewDragState = null; // { mode: 'move'|'resize'|'pen'|'erase', boxId?, offsetX?, offsetY?, stroke?, startX?, startY? }

function showToast(msg) {
  const box = document.getElementById('toastBox');
  if (!box) return;
  box.textContent = msg;
  box.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => box.classList.add('hidden'), 2800);
}

function ensureSheetsCount(count) {
  while (state.sheets.length < count) {
    state.sheets.push(makeSheet());
  }
}

function getCurrentSheet() {
  ensureSheetsCount(state.currentPage + 1);
  return state.sheets[state.currentPage];
}

function serializeSheetsForStorage(sheets) {
  return sheets.map((s) => ({
    id: s.id,
    paperOverride: s.paperOverride || 'inherit',
    importedPageIndex: s.importedPageIndex ?? null,
    textBoxes: s.textBoxes || [],
    strokes: s.strokes || [],
    whiteoutStrokes: s.whiteoutStrokes || [],
  }));
}

function hydrateSheetsFromStorage(rawSheets) {
  if (!Array.isArray(rawSheets) || rawSheets.length === 0) {
    return [makeSheet()];
  }
  return rawSheets.map((s) =>
    makeSheet({
      id: s.id || undefined,
      paperOverride: s.paperOverride || 'inherit',
      importedPageIndex: s.importedPageIndex ?? null,
      textBoxes: Array.isArray(s.textBoxes) ? s.textBoxes : [],
      strokes: Array.isArray(s.strokes) ? s.strokes : [],
      whiteoutStrokes: Array.isArray(s.whiteoutStrokes) ? s.whiteoutStrokes : [],
    })
  );
}

function loadStorage() {
  try {
    const savedGlyphs = localStorage.getItem(STORAGE_GLYPHS);
    if (savedGlyphs) state.glyphs = JSON.parse(savedGlyphs);
  } catch {}

  try {
    const savedNb = localStorage.getItem(STORAGE_NOTEBOOKS);
    if (savedNb) {
      state.notebooks = JSON.parse(savedNb);
    } else {
      state.notebooks = [
        {
          id: 'nb-' + Date.now(),
          title: 'Mein Heft',
          text: '',
          font: 'my-script',
          paper: 'grid',
          inkColor: '#1e3a8a',
          fontSize: 34,
          lineHeight: 46,
          letterSpacing: 0,
          margin: 64,
          sheets: serializeSheetsForStorage(state.sheets),
          updatedAt: new Date().toLocaleDateString('de-DE'),
        },
      ];
      saveNotebooksToStorage();
    }
  } catch {}
}

function saveGlyphsToStorage() {
  try {
    localStorage.setItem(STORAGE_GLYPHS, JSON.stringify(state.glyphs));
  } catch {
    showToast('Speicher voll – bitte alte Varianten löschen.');
  }
  updateTrainedCount();
}

function saveNotebooksToStorage() {
  try {
    localStorage.setItem(STORAGE_NOTEBOOKS, JSON.stringify(state.notebooks));
  } catch {}
  updateNotebookBadges();
}

function updateNotebookBadges() {
  const count = state.notebooks.length;
  const badge = document.getElementById('sidebarNotebookBadge');
  const pill = document.getElementById('notebookCountPill');
  if (badge) badge.textContent = String(count);
  if (pill) pill.textContent = count === 1 ? '1 Heft' : `${count} Hefte`;
}

function updateTrainedCount() {
  const count = Object.keys(state.glyphs).filter(
    (k) => Array.isArray(state.glyphs[k]) && state.glyphs[k].length > 0
  ).length;
  const el = document.getElementById('trainedCountBadge');
  if (el) el.textContent = `${count} Zeichen gespeichert`;
}

function closeMobileSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  sidebar?.classList.add('-translate-x-full');
  backdrop?.classList.add('hidden');
}

function setActiveView(view) {
  ['write', 'notebooks', 'my-script'].forEach((v) => {
    const viewId =
      v === 'write' ? 'viewWrite' : v === 'notebooks' ? 'viewNotebooks' : 'viewMyScript';
    const el = document.getElementById(viewId);
    const nav = document.getElementById('nav-' + v);
    if (!el || !nav) return;
    if (v === view) {
      el.classList.remove('hidden');
      nav.className =
        'w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium bg-[#182132] text-[#60a5fa] border border-[#24324d] transition';
    } else {
      el.classList.add('hidden');
      nav.className =
        'w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-medium text-gray-300 hover:bg-[#171a21] hover:text-white border border-transparent transition';
    }
  });

  const mobMap = {
    write: 'mobTabWrite',
    notebooks: 'mobTabNotebooks',
    'my-script': 'mobTabScript',
  };
  Object.entries(mobMap).forEach(([k, id]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.className =
      k === view
        ? 'px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#2563eb] text-white'
        : 'px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#171a21] text-gray-300';
  });

  const titles = {
    write: 'Schreiben & Blätter bearbeiten',
    notebooks: 'Meine Hefte',
    'my-script': 'Meine Schrift',
  };
  const sub = document.getElementById('subHeaderTitle');
  if (sub) sub.textContent = titles[view] || 'Schreiben';
  closeMobileSidebar();

  if (view === 'notebooks') renderNotebooksList();
  if (view === 'my-script') {
    renderAlphabetGrid();
    renderVariantsForChar(state.activeChar);
  }
  if (view === 'write') renderPreview();
}

function handleControlChange() {
  state.text = document.getElementById('writeTextarea').value;
  state.font = document.getElementById('fontSelect').value;
  state.paper = document.getElementById('paperSelect').value;
  state.title = document.getElementById('notebookTitleInput').value || 'Mein Heft';
  state.fontSize = parseInt(document.getElementById('sliderFontSize').value, 10);
  state.lineHeight = parseInt(document.getElementById('sliderLineHeight').value, 10);
  state.letterSpacing = parseInt(document.getElementById('sliderLetterSpacing').value, 10);
  state.margin = parseInt(document.getElementById('sliderMargin').value, 10);
  state.exportMode = document.getElementById('exportModeSelect')?.value || 'notability-editable';
  const editableCb = document.getElementById('editableFieldsCheckbox');
  if (editableCb) {
    state.editableTextFields = editableCb.checked;
  }

  document.getElementById('valFontSize').textContent = state.fontSize + ' px';
  document.getElementById('valLineHeight').textContent = state.lineHeight + ' px';
  document.getElementById('valLetterSpacing').textContent = state.letterSpacing + ' px';
  document.getElementById('valMargin').textContent = state.margin + ' px';
  document.getElementById('titlePreviewPill').textContent = 'Titel: ' + state.title;

  const trimmed = state.text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  document.getElementById('liveTextCounter').textContent = `${state.text.length} Zeichen · ${words} Wörter`;

  renderPreview();
}

function setInkColor(hex) {
  state.inkColor = hex;
  const sheet = getCurrentSheet();
  if (state.selectedBoxId) {
    const box = sheet.textBoxes.find((b) => b.id === state.selectedBoxId);
    if (box) box.inkColor = hex;
  }
  document.querySelectorAll('[data-ink-swatch]').forEach((btn) => {
    const isSelected = btn.getAttribute('data-ink-swatch') === hex;
    btn.classList.toggle('ring-2', isSelected);
    btn.classList.toggle('ring-offset-2', isSelected);
    btn.classList.toggle('ring-offset-[#151821]', isSelected);
    btn.classList.toggle('ring-blue-400', isSelected);
  });
  renderPreview();
}

function clearWriteText() {
  document.getElementById('writeTextarea').value = '';
  state.currentPage = 0;
  handleControlChange();
}

function insertPageBreak() {
  const ta = document.getElementById('writeTextarea');
  ta.value += (ta.value.endsWith('\n') || ta.value === '' ? '' : '\n') + '---SEITE---\n';
  handleControlChange();
}

function shuffleAllVariants() {
  state.seedOffset = Math.floor(Math.random() * 10000) + 1;
  renderPreview();
  showToast('Buchstaben-Varianten neu gemischt');
}

function resetAppearance() {
  state.inkColor = '#1e3a8a';
  document.getElementById('sliderFontSize').value = 34;
  document.getElementById('sliderLineHeight').value = 46;
  document.getElementById('sliderLetterSpacing').value = 0;
  document.getElementById('sliderMargin').value = 64;
  setInkColor('#1e3a8a');
  handleControlChange();
}

function convertImageToPngDataUrl(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || PAGE_W;
  c.height = img.naturalHeight || PAGE_H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

async function handleSheetFileUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    try {
      showToast('PDF-Blätter werden geladen...');
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() });
      const pdfDoc = await loadingTask.promise;

      const importedSheets = [];
      for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        const pdfPage = await pdfDoc.getPage(pageNum);
        const vp1 = pdfPage.getViewport({ scale: 1 });
        const scale = PAGE_W / vp1.width;
        const viewport = pdfPage.getViewport({ scale });

        const offscreen = document.createElement('canvas');
        offscreen.width = Math.round(viewport.width);
        offscreen.height = Math.round(viewport.height);
        const oCtx = offscreen.getContext('2d');
        await pdfPage.render({ canvasContext: oCtx, viewport }).promise;

        const dataUrl = offscreen.toDataURL('image/png');
        const previewImg = await new Promise((resolve) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.src = dataUrl;
        });

        importedSheets.push(
          makeSheet({
            paperOverride: 'imported-pdf',
            importedPageIndex: pageNum - 1,
            importedPreviewDataUrl: dataUrl,
            importedPreviewImg: previewImg,
          })
        );
      }

      state.basePdfBytes = bytes;
      state.basePdfName = file.name;
      state.sheets = importedSheets;
      state.currentPage = 0;
      state.selectedBoxId = null;
      document.getElementById('paperSelect').value = 'imported-pdf';
      state.paper = 'imported-pdf';

      const bgBar = document.getElementById('customBgBar');
      bgBar.classList.remove('hidden');
      bgBar.classList.add('flex');
      document.getElementById('customBgName').textContent =
        `PDF geladen (${pdfDoc.numPages} Blätter): ${file.name}`;
      handleControlChange();
      showToast(`${pdfDoc.numPages} PDF-Blätter zum Bearbeiten geladen!`);
    } catch (err) {
      console.error(err);
      showToast('PDF konnte nicht gelesen werden.');
    }
    event.target.value = '';
    return;
  }

  // Image upload (PNG, JPEG, WebP)
  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      let dataUrl = e.target.result;
      if (!dataUrl.startsWith('data:image/png') && !dataUrl.startsWith('data:image/jpeg')) {
        dataUrl = convertImageToPngDataUrl(img);
      }
      state.customBgDataUrl = dataUrl;
      state.customBgImage = img;
      state.basePdfBytes = null;
      state.basePdfName = null;
      document.getElementById('paperSelect').value = 'custom-png';
      const bgBar = document.getElementById('customBgBar');
      bgBar.classList.remove('hidden');
      bgBar.classList.add('flex');
      document.getElementById('customBgName').textContent = 'Blatt-Bild aktiv: ' + file.name;
      handleControlChange();
      showToast('Blatt-Hintergrundbild geladen');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function removeCustomBackground() {
  state.customBgDataUrl = null;
  state.customBgImage = null;
  state.basePdfBytes = null;
  state.basePdfName = null;
  state.sheets.forEach((s) => {
    if (s.paperOverride === 'imported-pdf' || s.paperOverride === 'custom-png') {
      s.paperOverride = 'inherit';
      s.importedPageIndex = null;
      s.importedPreviewDataUrl = null;
      s.importedPreviewImg = null;
    }
  });
  document.getElementById('paperSelect').value = 'grid';
  document.getElementById('customBgBar').classList.add('hidden');
  document.getElementById('customBgBar').classList.remove('flex');
  handleControlChange();
}

function drawPaperBackground(ctx, W, H, sheet) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const effectivePaper =
    sheet?.paperOverride && sheet.paperOverride !== 'inherit'
      ? sheet.paperOverride
      : state.paper;

  if (effectivePaper === 'imported-pdf' && sheet?.importedPreviewImg) {
    ctx.drawImage(sheet.importedPreviewImg, 0, 0, W, H);
    return;
  }

  if (effectivePaper === 'custom-png' && (sheet?.customBgImage || state.customBgImage)) {
    ctx.drawImage(sheet?.customBgImage || state.customBgImage, 0, 0, W, H);
    return;
  }

  if (effectivePaper === 'grid') {
    const step = 19;
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let x = step; x < W; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = step; y < H; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(54, 0);
    ctx.lineTo(54, H);
    ctx.stroke();
  } else if (effectivePaper === 'lined') {
    const step = state.lineHeight;
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let y = state.margin + state.fontSize + 6; y < H - 30; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();

    ctx.strokeStyle = '#fca5a5';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(54, 0);
    ctx.lineTo(54, H);
    ctx.stroke();
  }
}

function drawStrokesGlyph(ctx, strokes, x, y, size, color, minX = null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.6, size * 0.065);

  const scale = size / 145;
  const resolvedMinX =
    typeof minX === 'number' ? minX : getGlyphHorizontalMetrics(strokes).minX;
  const drawX = x - resolvedMinX * scale + size * 0.03;
  const drawY = y - size * 0.98;

  strokes.forEach((stroke) => {
    if (!stroke || stroke.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(drawX + stroke[0].x * scale, drawY + stroke[0].y * scale);
    for (let i = 1; i < stroke.length; i++) {
      ctx.lineTo(drawX + stroke[i].x * scale, drawY + stroke[i].y * scale);
    }
    ctx.stroke();
  });
  ctx.restore();
}

function renderHandwritingItems(ctx, items, fontSize, inkColor) {
  items.forEach((item) => {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rot);

    if (
      state.font === 'my-script' &&
      item.variantIdx >= 0 &&
      state.glyphs[item.ch]?.[item.variantIdx]
    ) {
      drawStrokesGlyph(
        ctx,
        state.glyphs[item.ch][item.variantIdx],
        0,
        0,
        fontSize,
        inkColor,
        item.minX
      );
    } else {
      const fallbackFamily =
        state.font === 'patrick' ? '"Patrick Hand", cursive' : '"Caveat", cursive';
      ctx.font = `${fontSize}px ${fallbackFamily}`;
      ctx.fillStyle = inkColor;
      ctx.fillText(item.ch, 0, 0);
    }
    ctx.restore();
  });
}

function getComputedBoxLayout(box, pageIdx, boxIdx) {
  const fs = box.fontSize || state.fontSize;
  const lh = Math.round(fs * 1.32);
  return layoutBoxText({
    text: box.text || '',
    font: state.font,
    x: box.x,
    y: box.y,
    width: box.width || 300,
    fontSize: fs,
    lineHeight: lh,
    letterSpacing: state.letterSpacing,
    seedOffset: state.seedOffset,
    glyphs: state.glyphs,
    seedBase: (pageIdx + 1) * 10000 + boxIdx * 500,
    measureCharWidth,
  });
}

function drawStrokeList(ctx, strokes, defaultColor, defaultWidth) {
  (strokes || []).forEach((s) => {
    if (!s.points || s.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = s.color || defaultColor;
    ctx.lineWidth = s.width || defaultWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  });
}

function renderPageToCanvas(canvas, flowPage, sheet, pageIdx) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  drawPaperBackground(ctx, W, H, sheet);

  if (flowPage?.items?.length) {
    renderHandwritingItems(ctx, flowPage.items, state.fontSize, state.inkColor);
  }

  // Whiteout / Tipp-Ex strokes (can cover imported PDFs, paper lines, or flow text)
  drawStrokeList(ctx, sheet?.whiteoutStrokes, '#ffffff', 18);

  // Placed editable text boxes on this sheet
  const boxes = sheet?.textBoxes || [];
  boxes.forEach((box, bIdx) => {
    const fs = box.fontSize || state.fontSize;
    const color = box.inkColor || state.inkColor;
    const layout = getComputedBoxLayout(box, pageIdx, bIdx);

    if (layout.items.length > 0) {
      renderHandwritingItems(ctx, layout.items, fs, color);
    } else {
      ctx.save();
      ctx.font = '13px Inter, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('Text hier eingeben...', box.x + 8, box.y + 24);
      ctx.restore();
    }

    if (box.id === state.selectedBoxId) {
      ctx.save();
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(box.x - 4, box.y - 4, box.width + 8, layout.boxHeight + 8);
      ctx.setLineDash([]);
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(box.x + box.width - 2, box.y + layout.boxHeight - 2, 10, 10);
      ctx.restore();
    }
  });

  // Freehand strokes on this sheet
  drawStrokeList(ctx, sheet?.strokes, state.inkColor, 3);
}

function updateSelectedBoxInspector() {
  const inspector = document.getElementById('selectedBoxInspector');
  if (!inspector) return;
  const sheet = getCurrentSheet();
  const box = sheet.textBoxes.find((b) => b.id === state.selectedBoxId);
  if (!box) {
    inspector.classList.add('hidden');
    return;
  }
  inspector.classList.remove('hidden');
  const ta = document.getElementById('selectedBoxTextarea');
  const fsInput = document.getElementById('selectedBoxFontSize');
  const fsLabel = document.getElementById('selectedBoxFontSizeVal');
  if (ta && ta.value !== box.text) ta.value = box.text || '';
  if (fsInput) fsInput.value = String(box.fontSize || state.fontSize);
  if (fsLabel) fsLabel.textContent = `${box.fontSize || state.fontSize} px`;
}

function renderPreview() {
  cachedFlowPages = computeTextPages({
    text: state.text,
    font: state.font,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    letterSpacing: state.letterSpacing,
    margin: state.margin,
    seedOffset: state.seedOffset,
    glyphs: state.glyphs,
    measureCharWidth,
  });

  const totalPages = Math.max(cachedFlowPages.length, state.sheets.length, 1);
  ensureSheetsCount(totalPages);

  if (state.currentPage >= totalPages) state.currentPage = totalPages - 1;
  if (state.currentPage < 0) state.currentPage = 0;

  const indicator = document.getElementById('pageIndicator');
  if (indicator) indicator.textContent = `Blatt ${state.currentPage + 1} / ${totalPages}`;

  const canvas = document.getElementById('previewCanvas');
  if (!canvas) return;
  canvas.setAttribute('data-page-count', String(totalPages));
  canvas.setAttribute('data-current-page', String(state.currentPage + 1));
  canvas.setAttribute('data-active-tool', state.canvasTool);

  const sheet = state.sheets[state.currentPage];
  renderPageToCanvas(canvas, cachedFlowPages[state.currentPage], sheet, state.currentPage);
  updateSelectedBoxInspector();
}

function changePreviewPage(delta) {
  const totalPages = Math.max(cachedFlowPages.length, state.sheets.length, 1);
  const next = state.currentPage + delta;
  if (next >= 0 && next < totalPages) {
    state.currentPage = next;
    state.selectedBoxId = null;
    renderPreview();
  }
}

function setCanvasTool(tool) {
  state.canvasTool = tool;
  if (tool !== 'select') {
    state.selectedBoxId = null;
  }
  document.querySelectorAll('[data-sheet-tool]').forEach((btn) => {
    const active = btn.getAttribute('data-sheet-tool') === tool;
    btn.className = active
      ? 'px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#2563eb] text-white transition flex items-center gap-1.5'
      : 'px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[#0f1117] border border-[#262a34] text-gray-300 hover:text-white transition flex items-center gap-1.5';
  });

  const canvas = document.getElementById('previewCanvas');
  if (canvas) {
    canvas.style.cursor =
      tool === 'pen' || tool === 'whiteout'
        ? 'crosshair'
        : tool === 'textbox'
          ? 'text'
          : tool === 'eraser'
            ? 'cell'
            : 'default';
  }
  renderPreview();
}

function pushSheetUndo(includeGlobal = false) {
  if (includeGlobal) {
    sheetUndoStack.push({
      kind: 'global',
      pageIndex: state.currentPage,
      text: state.text,
      sheets: serializeSheetsForStorage(state.sheets),
    });
  } else {
    const sheet = getCurrentSheet();
    sheetUndoStack.push({
      kind: 'page',
      pageIndex: state.currentPage,
      text: state.text,
      textBoxes: JSON.parse(JSON.stringify(sheet.textBoxes || [])),
      strokes: JSON.parse(JSON.stringify(sheet.strokes || [])),
      whiteoutStrokes: JSON.parse(JSON.stringify(sheet.whiteoutStrokes || [])),
    });
  }
  if (sheetUndoStack.length > 30) sheetUndoStack.shift();
}

function undoSheetAction() {
  if (sheetUndoStack.length === 0) {
    showToast('Nichts zum Rückgängig machen');
    return;
  }
  const top = sheetUndoStack[sheetUndoStack.length - 1];
  if (top.kind === 'global') {
    sheetUndoStack.pop();
    state.text = top.text || '';
    const ta = document.getElementById('writeTextarea');
    if (ta) ta.value = state.text;
    const oldSheets = state.sheets;
    state.sheets = hydrateSheetsFromStorage(top.sheets).map((ns, idx) => {
      const prev = oldSheets[idx];
      if (prev && ns.paperOverride === 'imported-pdf') {
        ns.importedPreviewDataUrl = prev.importedPreviewDataUrl;
        ns.importedPreviewImg = prev.importedPreviewImg;
      }
      return ns;
    });
    state.currentPage = Math.max(0, Math.min(state.sheets.length - 1, top.pageIndex));
    state.selectedBoxId = null;
    handleControlChange();
    showToast('Aktion rückgängig gemacht');
    return;
  }

  for (let i = sheetUndoStack.length - 1; i >= 0; i--) {
    if (sheetUndoStack[i].pageIndex === state.currentPage) {
      const snap = sheetUndoStack.splice(i, 1)[0];
      if (typeof snap.text === 'string' && snap.text !== state.text) {
        state.text = snap.text;
        const ta = document.getElementById('writeTextarea');
        if (ta) ta.value = state.text;
      }
      const sheet = getCurrentSheet();
      sheet.textBoxes = snap.textBoxes;
      sheet.strokes = snap.strokes;
      sheet.whiteoutStrokes = snap.whiteoutStrokes || [];
      state.selectedBoxId = null;
      handleControlChange();
      showToast('Aktion rückgängig gemacht');
      return;
    }
  }
  showToast('Nichts zum Rückgängig machen auf diesem Blatt');
}

function addBlankSheet() {
  const newSheet = makeSheet({
    paperOverride: state.paper === 'imported-pdf' ? 'grid' : 'inherit',
  });
  state.sheets.push(newSheet);
  state.currentPage = state.sheets.length - 1;
  state.selectedBoxId = null;
  renderPreview();
  showToast(`Blatt ${state.currentPage + 1} hinzugefügt`);
}

function deleteCurrentSheet() {
  pushSheetUndo(true);
  if (state.sheets.length <= 1) {
    const sheet = getCurrentSheet();
    sheet.textBoxes = [];
    sheet.strokes = [];
    sheet.whiteoutStrokes = [];
    state.text = '';
    const ta = document.getElementById('writeTextarea');
    if (ta) ta.value = '';
    state.selectedBoxId = null;
    handleControlChange();
    showToast('Blatt komplett geleert');
    return;
  }

  const flowPage = cachedFlowPages[state.currentPage];
  if (flowPage?.items?.length) {
    const starts = flowPage.items.map((i) => i.wordStart).filter((n) => typeof n === 'number');
    const ends = flowPage.items.map((i) => i.wordEnd).filter((n) => typeof n === 'number');
    if (starts.length > 0 && ends.length > 0) {
      let delStart = Math.min(...starts);
      let delEnd = Math.max(...ends);
      const before = state.text.slice(0, delStart);
      const after = state.text.slice(delEnd);
      const trailingBreak = after.match(/^\s*---SEITE---\s*/);
      const leadingBreak = before.match(/\s*---SEITE---\s*$/);
      if (trailingBreak) {
        delEnd += trailingBreak[0].length;
      } else if (leadingBreak) {
        delStart -= leadingBreak[0].length;
      } else if (after.startsWith('\n')) {
        delEnd += 1;
      }
      state.text = (state.text.slice(0, delStart) + state.text.slice(delEnd)).trim();
      const ta = document.getElementById('writeTextarea');
      if (ta) ta.value = state.text;
    }
  }

  state.sheets.splice(state.currentPage, 1);
  if (state.currentPage >= state.sheets.length) {
    state.currentPage = state.sheets.length - 1;
  }
  state.selectedBoxId = null;
  handleControlChange();
  showToast('Blatt gelöscht');
}

function addTextBoxAt(x, y, initialText = '') {
  const sheet = getCurrentSheet();
  pushSheetUndo();
  const clampedX = Math.max(20, Math.min(PAGE_W - 220, x));
  const clampedY = Math.max(20, Math.min(PAGE_H - 80, y));
  const box = {
    id: 'tb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    text: initialText,
    x: clampedX,
    y: clampedY,
    width: 280,
    fontSize: Math.min(34, state.fontSize),
    inkColor: state.inkColor,
  };
  sheet.textBoxes.push(box);
  state.selectedBoxId = box.id;
  setCanvasTool('select');
  renderPreview();
  setTimeout(() => {
    const ta = document.getElementById('selectedBoxTextarea');
    ta?.focus();
  }, 20);
}

function getPreviewPoint(e) {
  const canvas = document.getElementById('previewCanvas');
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * PAGE_W) / rect.width,
    y: ((e.clientY - rect.top) * PAGE_H) / rect.height,
  };
}

function eraseAtPoint(sheet, pt, allowFlowWord) {
  let changed = false;

  const beforeStrokes = (sheet.strokes || []).length;
  sheet.strokes = (sheet.strokes || []).filter((s) => !hitTestStroke(s, pt, 16));
  if (sheet.strokes.length !== beforeStrokes) changed = true;

  const beforeWhite = (sheet.whiteoutStrokes || []).length;
  sheet.whiteoutStrokes = (sheet.whiteoutStrokes || []).filter((s) => !hitTestStroke(s, pt, 18));
  if (sheet.whiteoutStrokes.length !== beforeWhite) changed = true;

  const boxes = sheet.textBoxes || [];
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    const layout = getComputedBoxLayout(b, state.currentPage, i);
    const res = hitTestTextBox(b, pt, layout.boxHeight);
    if (res.hit) {
      boxes.splice(i, 1);
      if (state.selectedBoxId === b.id) state.selectedBoxId = null;
      changed = true;
    }
  }

  if (allowFlowWord) {
    const flowPage = cachedFlowPages[state.currentPage];
    const hitWord = findFlowWordAtPoint(flowPage?.items, pt, state.fontSize);
    if (hitWord) {
      const nextText = removeWordRangeFromText(state.text, hitWord.wordStart, hitWord.wordEnd);
      if (nextText !== state.text) {
        state.text = nextText;
        const ta = document.getElementById('writeTextarea');
        if (ta) ta.value = nextText;
        changed = true;
      }
    }
  }

  return changed;
}

function attachPreviewCanvasEvents() {
  const canvas = document.getElementById('previewCanvas');
  if (!canvas) return;

  canvas.addEventListener('pointerdown', (e) => {
    const pt = getPreviewPoint(e);
    const sheet = getCurrentSheet();

    if (state.canvasTool === 'textbox') {
      addTextBoxAt(pt.x, pt.y, '');
      return;
    }

    if (state.canvasTool === 'pen') {
      pushSheetUndo();
      const stroke = {
        id: 'st-' + Date.now(),
        color: state.inkColor,
        width: 3,
        points: [pt],
      };
      sheet.strokes.push(stroke);
      previewDragState = { mode: 'pen', stroke };
      renderPreview();
      return;
    }

    if (state.canvasTool === 'whiteout') {
      pushSheetUndo();
      if (!Array.isArray(sheet.whiteoutStrokes)) sheet.whiteoutStrokes = [];
      const wStroke = {
        id: 'wo-' + Date.now(),
        color: '#ffffff',
        width: 20,
        points: [pt],
      };
      sheet.whiteoutStrokes.push(wStroke);
      previewDragState = { mode: 'whiteout', stroke: wStroke };
      renderPreview();
      return;
    }

    if (state.canvasTool === 'eraser') {
      pushSheetUndo();
      previewDragState = { mode: 'erase' };
      const changed = eraseAtPoint(sheet, pt, true);
      if (changed) handleControlChange();
      return;
    }

    // 'select' tool
    let hitBox = null;
    let hitHandle = null;
    for (let i = sheet.textBoxes.length - 1; i >= 0; i--) {
      const b = sheet.textBoxes[i];
      const layout = getComputedBoxLayout(b, state.currentPage, i);
      const res = hitTestTextBox(b, pt, layout.boxHeight);
      if (res.hit) {
        hitBox = b;
        hitHandle = res.handle;
        break;
      }
    }

    if (hitBox) {
      state.selectedBoxId = hitBox.id;
      pushSheetUndo();
      previewDragState = {
        mode: hitHandle === 'resize' ? 'resize' : 'move',
        boxId: hitBox.id,
        offsetX: pt.x - hitBox.x,
        offsetY: pt.y - hitBox.y,
        startX: pt.x,
        startWidth: hitBox.width,
      };
    } else {
      state.selectedBoxId = null;
    }
    renderPreview();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!previewDragState) return;
    const pt = getPreviewPoint(e);
    const sheet = getCurrentSheet();

    if ((previewDragState.mode === 'pen' || previewDragState.mode === 'whiteout') && previewDragState.stroke) {
      previewDragState.stroke.points.push(pt);
      renderPreview();
    } else if (previewDragState.mode === 'erase') {
      const changed = eraseAtPoint(sheet, pt, false);
      if (changed) renderPreview();
    } else if (previewDragState.mode === 'move') {
      const box = sheet.textBoxes.find((b) => b.id === previewDragState.boxId);
      if (box) {
        box.x = Math.max(10, Math.min(PAGE_W - 60, Math.round(pt.x - previewDragState.offsetX)));
        box.y = Math.max(10, Math.min(PAGE_H - 40, Math.round(pt.y - previewDragState.offsetY)));
        renderPreview();
      }
    } else if (previewDragState.mode === 'resize') {
      const box = sheet.textBoxes.find((b) => b.id === previewDragState.boxId);
      if (box) {
        const deltaX = pt.x - previewDragState.startX;
        box.width = Math.max(100, Math.min(PAGE_W - box.x - 16, Math.round(previewDragState.startWidth + deltaX)));
        renderPreview();
      }
    }
  });

  window.addEventListener('pointerup', () => {
    previewDragState = null;
  });

  canvas.addEventListener('dblclick', () => {
    if (state.selectedBoxId) {
      document.getElementById('selectedBoxTextarea')?.focus();
    }
  });
}

// High-res glyph sprite renderer for Caveat / Patrick Hand (replaces old blocky 4px rect loops)
let spriteCanvas = null;
let spriteCtx = null;
function renderFallbackGlyphPng(ch, fontName, inkColor) {
  if (!ch || ch === ' ') return null;
  if (!spriteCanvas) {
    spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = 192;
    spriteCanvas.height = 192;
    spriteCtx = spriteCanvas.getContext('2d');
  }
  spriteCtx.clearRect(0, 0, 192, 192);
  const family = fontName === 'patrick' ? '"Patrick Hand", cursive' : '"Caveat", cursive';
  spriteCtx.font = `128px ${family}`;
  spriteCtx.fillStyle = inkColor || '#1e3a8a';
  spriteCtx.textBaseline = 'alphabetic';
  spriteCtx.fillText(ch, 40, 140);
  return spriteCanvas.toDataURL('image/png');
}

async function exportNotabilityPdf() {
  const btn = document.getElementById('exportPdfBtn');
  const origText = btn.textContent;
  btn.textContent = '⏳ Bearbeitbares Notability-PDF wird erstellt...';
  btn.disabled = true;

  try {
    const pdfBytes = await buildNotabilityPdf({
      text: state.text,
      font: state.font,
      paper: state.paper,
      title: state.title,
      inkColor: state.inkColor,
      fontSize: state.fontSize,
      lineHeight: state.lineHeight,
      letterSpacing: state.letterSpacing,
      margin: state.margin,
      seedOffset: state.seedOffset,
      glyphs: state.glyphs,
      customBgDataUrl: state.customBgDataUrl,
      basePdfBytes: state.basePdfBytes,
      sheets: state.sheets,
      exportMode: state.exportMode,
      editableTextFields: state.editableTextFields,
      renderFallbackGlyphPng,
      measureCharWidth,
    });

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (state.title || 'SchoolFucker').replace(/[^a-zA-Z0-9äöüÄÖÜ_-]/g, '_');
    a.href = url;
    a.download = `${safeName}_Notability.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Bearbeitbares Notability-PDF exportiert!');
  } catch (err) {
    console.error('PDF export error:', err);
    showToast('Fehler beim PDF-Export');
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

function buildTransparentHandwritingCanvas(scale = 3) {
  const sheet = getCurrentSheet();
  const flowPage = cachedFlowPages[state.currentPage];
  const offscreen = document.createElement('canvas');
  offscreen.width = PAGE_W * scale;
  offscreen.height = PAGE_H * scale;
  const ctx = offscreen.getContext('2d');
  ctx.scale(scale, scale);

  if (flowPage?.items?.length) {
    renderHandwritingItems(ctx, flowPage.items, state.fontSize, state.inkColor);
  }
  (sheet?.textBoxes || []).forEach((box, bIdx) => {
    const fs = box.fontSize || state.fontSize;
    const color = box.inkColor || state.inkColor;
    const layout = getComputedBoxLayout(box, state.currentPage, bIdx);
    if (layout.items.length > 0) {
      renderHandwritingItems(ctx, layout.items, fs, color);
    }
  });
  drawStrokeList(ctx, sheet?.strokes, state.inkColor, 3);

  const imgData = ctx.getImageData(0, 0, offscreen.width, offscreen.height).data;
  let minX = offscreen.width;
  let minY = offscreen.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < offscreen.height; y++) {
    const rowOffset = y * offscreen.width * 4;
    for (let x = 0; x < offscreen.width; x++) {
      if (imgData[rowOffset + x * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  const pad = Math.round(12 * scale);
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(offscreen.width - sx, maxX - minX + 1 + pad * 2);
  const sh = Math.min(offscreen.height - sy, maxY - minY + 1 + pad * 2);

  const cropped = document.createElement('canvas');
  cropped.width = sw;
  cropped.height = sh;
  cropped.getContext('2d').drawImage(offscreen, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped;
}

function downloadCanvasPng(canvas) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeName = (state.title || 'SchoolFucker').replace(/[^a-zA-Z0-9äöüÄÖÜ_-]/g, '_');
    a.href = url;
    a.download = `${safeName}_Blatt_${state.currentPage + 1}_Transparent.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

function exportTransparentHandwritingPng() {
  const cropped = buildTransparentHandwritingCanvas(3);
  if (!cropped) {
    showToast('Keine Handschrift auf diesem Blatt vorhanden');
    return;
  }
  downloadCanvasPng(cropped);
  showToast('Transparentes Handschrift-PNG exportiert (in Notability einfügen, verschieben & zuschneiden)!');
}

async function copyTransparentHandwritingPng() {
  const cropped = buildTransparentHandwritingCanvas(3);
  if (!cropped) {
    showToast('Schreibe zuerst etwas Text aufs Blatt!');
    return;
  }

  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    downloadCanvasPng(cropped);
    showToast('Zwischenablage hier nicht verfügbar – Transparentes PNG stattdessen geladen!');
    return;
  }

  try {
    const blobPromise = new Promise((resolve, reject) => {
      cropped.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('PNG conversion failed'));
      }, 'image/png');
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    showToast('Handschrift kopiert! Jetzt in Notability aufs Blatt tippen → „Einsetzen“.');
  } catch (err) {
    console.warn('Clipboard write fallback to download:', err);
    downloadCanvasPng(cropped);
    showToast('Zwischenablage blockiert – Transparentes PNG wurde heruntergeladen!');
  }
}

function exportHandwritingTtf() {
  const trained = Object.keys(state.glyphs).filter(
    (k) => Array.isArray(state.glyphs[k]) && state.glyphs[k].length > 0
  );
  if (trained.length === 0) {
    showToast('Zeichne zuerst mindestens ein paar Buchstaben unter "Meine Schrift"!');
    setActiveView('my-script');
    return;
  }
  try {
    const { arrayBuffer, glyphCount, familyName, postScriptName } = buildHandwritingTtf({
      familyName: state.title || 'MeineHandschrift',
      glyphs: state.glyphs,
    });
    const blob = new Blob([arrayBuffer], { type: 'font/ttf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${postScriptName || familyName.replace(/\s+/g, '_')}.ttf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const hint =
      glyphCount < 15
        ? ` (Hinweis: Nur ${glyphCount} gezeichnete Buchstaben werden ersetzt!)`
        : '';
    showToast(`${familyName}.ttf (${glyphCount} Zeichen) geladen – mit iFont/Fontcase installieren, dann in Notability unter Tt auswählen.${hint}`);
  } catch (err) {
    console.error('TTF export error:', err);
    showToast('Fehler beim Erstellen der .ttf-Schriftart');
  }
}

function exportHandwritingMobileConfig() {
  const trained = Object.keys(state.glyphs).filter(
    (k) => Array.isArray(state.glyphs[k]) && state.glyphs[k].length > 0
  );
  if (trained.length === 0) {
    showToast('Zeichne zuerst mindestens ein paar Buchstaben unter "Meine Schrift"!');
    setActiveView('my-script');
    return;
  }
  try {
    const { arrayBuffer, glyphCount, familyName, postScriptName } = buildHandwritingTtf({
      familyName: state.title || 'MeineHandschrift',
      glyphs: state.glyphs,
    });
    const xml = buildIosFontMobileConfig({ familyName, postScriptName, arrayBuffer });
    const blob = new Blob([xml], { type: 'application/x-apple-aspen-config' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${familyName.replace(/\s+/g, '_')}.mobileconfig`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const partialHint =
      glyphCount < 15
        ? ` Achtung: Nur ${glyphCount} Zeichen trainiert – fehlende Buchstaben bleiben Standardschrift!`
        : '';
    showToast(
      `${familyName}.mobileconfig (${glyphCount} Zeichen) geladen → Profil installieren, dann in Notability bei Tt unten in der Leiste „${familyName}“ wählen!${partialHint}`
    );
  } catch (err) {
    console.error('MobileConfig export error:', err);
    showToast('Fehler beim Erstellen des iPad-Profils');
  }
}

function uint8ToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToUint8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function exportProjectJson() {
  const payload = {
    version: 2,
    title: state.title,
    text: state.text,
    font: state.font,
    paper: state.paper,
    inkColor: state.inkColor,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    letterSpacing: state.letterSpacing,
    margin: state.margin,
    exportMode: state.exportMode,
    editableTextFields: state.editableTextFields,
    customBgDataUrl: state.customBgDataUrl,
    basePdfName: state.basePdfName,
    basePdfBase64: state.basePdfBytes ? uint8ToBase64(state.basePdfBytes) : null,
    sheets: serializeSheetsForStorage(state.sheets),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (state.title || 'SchoolFucker').replace(/[^a-zA-Z0-9äöüÄÖÜ_-]/g, '_');
  a.href = url;
  a.download = `${safeName}_Projekt.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast('Bearbeitbares Projekt (.json) gespeichert');
}

async function importProjectJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const raw = await file.text();
    const data = JSON.parse(raw);

    document.getElementById('writeTextarea').value = data.text || '';
    document.getElementById('notebookTitleInput').value = data.title || 'Mein Heft';
    document.getElementById('fontSelect').value = data.font || 'my-script';
    document.getElementById('paperSelect').value = data.paper || 'grid';
    document.getElementById('sliderFontSize').value = data.fontSize || 34;
    document.getElementById('sliderLineHeight').value = data.lineHeight || 46;
    document.getElementById('sliderLetterSpacing').value = data.letterSpacing ?? 0;
    document.getElementById('sliderMargin').value = data.margin || 64;
    if (data.exportMode && document.getElementById('exportModeSelect')) {
      document.getElementById('exportModeSelect').value = data.exportMode;
    }
    if (typeof data.editableTextFields === 'boolean') {
      document.getElementById('editableFieldsCheckbox').checked = data.editableTextFields;
    }

    state.inkColor = data.inkColor || '#1e3a8a';
    state.sheets = hydrateSheetsFromStorage(data.sheets);
    state.selectedBoxId = null;
    state.currentPage = 0;

    if (data.basePdfBase64) {
      const bytes = base64ToUint8(data.basePdfBase64);
      state.basePdfBytes = bytes;
      state.basePdfName = data.basePdfName || 'Arbeitsblatt.pdf';
      const pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      for (const s of state.sheets) {
        if (s.paperOverride === 'imported-pdf' && typeof s.importedPageIndex === 'number') {
          const pIdx = Math.min(pdfDoc.numPages, Math.max(1, s.importedPageIndex + 1));
          const pdfPage = await pdfDoc.getPage(pIdx);
          const vp1 = pdfPage.getViewport({ scale: 1 });
          const viewport = pdfPage.getViewport({ scale: PAGE_W / vp1.width });
          const offscreen = document.createElement('canvas');
          offscreen.width = Math.round(viewport.width);
          offscreen.height = Math.round(viewport.height);
          await pdfPage.render({ canvasContext: offscreen.getContext('2d'), viewport }).promise;
          const url = offscreen.toDataURL('image/png');
          s.importedPreviewDataUrl = url;
          s.importedPreviewImg = await new Promise((resolve) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.src = url;
          });
        }
      }
    } else if (data.customBgDataUrl) {
      state.customBgDataUrl = data.customBgDataUrl;
      state.customBgImage = await new Promise((resolve) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.src = data.customBgDataUrl;
      });
    }

    handleControlChange();
    showToast('Projekt geladen – alle Blätter wieder bearbeitbar!');
  } catch (err) {
    console.error(err);
    showToast('Projektdatei ungültig');
  }
  event.target.value = '';
}

function saveCurrentNotebook() {
  const title = (document.getElementById('notebookTitleInput').value || 'Mein Heft').trim();
  const existingIdx = state.notebooks.findIndex((n) => n.title === title);
  const entry = {
    id: existingIdx >= 0 ? state.notebooks[existingIdx].id : 'nb-' + Date.now(),
    title,
    text: state.text,
    font: state.font,
    paper: state.paper === 'imported-pdf' ? 'grid' : state.paper,
    inkColor: state.inkColor,
    fontSize: state.fontSize,
    lineHeight: state.lineHeight,
    letterSpacing: state.letterSpacing,
    margin: state.margin,
    sheets: serializeSheetsForStorage(state.sheets),
    updatedAt: new Date().toLocaleDateString('de-DE'),
  };

  if (existingIdx >= 0) {
    state.notebooks[existingIdx] = entry;
  } else {
    state.notebooks.unshift(entry);
  }
  saveNotebooksToStorage();
  showToast(`Heft "${title}" gespeichert`);
}

function renderNotebooksList() {
  const grid = document.getElementById('notebooksGrid');
  if (!grid) return;
  if (state.notebooks.length === 0) {
    grid.innerHTML = `<div class="col-span-full bg-[#151821] border border-[#262a34] rounded-2xl p-6 text-center text-xs text-gray-400">Noch keine Hefte gespeichert.</div>`;
    return;
  }

  grid.innerHTML = state.notebooks
    .map(
      (nb) => `
      <div class="bg-[#151821] border border-[#262a34] rounded-2xl p-4 flex flex-col justify-between space-y-3">
        <div>
          <div class="flex items-start justify-between gap-2">
            <h3 class="font-bold text-sm text-white truncate">${nb.title.replace(/</g, '&lt;')}</h3>
            <span class="text-[10px] text-gray-400 shrink-0">${nb.updatedAt || ''}</span>
          </div>
          <p class="text-xs text-gray-400 mt-2 line-clamp-3">${nb.text ? nb.text.replace(/</g, '&lt;') : 'Leeres Heft'}</p>
        </div>
        <div class="flex items-center gap-2 pt-2 border-t border-[#262a34]">
          <button data-open-nb="${nb.id}" class="flex-1 py-1.5 rounded-lg bg-[#2563eb] hover:bg-[#1d4ed8] text-xs font-semibold text-white transition">Öffnen</button>
          <button data-del-nb="${nb.id}" class="px-3 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900/70 border border-red-800/50 text-xs font-medium text-red-300 transition">Löschen</button>
        </div>
      </div>`
    )
    .join('');

  grid.querySelectorAll('[data-open-nb]').forEach((btn) => {
    btn.addEventListener('click', () => openNotebook(btn.getAttribute('data-open-nb')));
  });
  grid.querySelectorAll('[data-del-nb]').forEach((btn) => {
    btn.addEventListener('click', () => deleteNotebook(btn.getAttribute('data-del-nb')));
  });
}

function openNotebook(id) {
  const nb = state.notebooks.find((n) => n.id === id);
  if (!nb) return;
  document.getElementById('writeTextarea').value = nb.text || '';
  document.getElementById('notebookTitleInput').value = nb.title || 'Mein Heft';
  document.getElementById('fontSelect').value = nb.font || 'my-script';
  document.getElementById('paperSelect').value = nb.paper || 'grid';
  document.getElementById('sliderFontSize').value = nb.fontSize || 34;
  document.getElementById('sliderLineHeight').value = nb.lineHeight || 46;
  document.getElementById('sliderLetterSpacing').value = nb.letterSpacing ?? 0;
  document.getElementById('sliderMargin').value = nb.margin || 64;
  state.inkColor = nb.inkColor || '#1e3a8a';
  state.sheets = hydrateSheetsFromStorage(nb.sheets);
  state.currentPage = 0;
  state.selectedBoxId = null;
  setInkColor(state.inkColor);
  handleControlChange();
  setActiveView('write');
}

function deleteNotebook(id) {
  state.notebooks = state.notebooks.filter((n) => n.id !== id);
  saveNotebooksToStorage();
  renderNotebooksList();
  showToast('Heft gelöscht');
}

// Glyph training canvas
let currentStrokes = [];
let activeStroke = null;
let isDrawingGlyph = false;

function drawGlyphGuidelines() {
  const glyphCanvas = document.getElementById('glyphDrawCanvas');
  if (!glyphCanvas) return;
  const gCtx = glyphCanvas.getContext('2d');
  gCtx.clearRect(0, 0, 260, 260);
  gCtx.fillStyle = '#ffffff';
  gCtx.fillRect(0, 0, 260, 260);

  gCtx.strokeStyle = '#e2e8f0';
  gCtx.lineWidth = 1;
  gCtx.setLineDash([4, 4]);
  gCtx.beginPath();
  gCtx.moveTo(0, 80);
  gCtx.lineTo(260, 80);
  gCtx.moveTo(0, 140);
  gCtx.lineTo(260, 140);
  gCtx.stroke();

  gCtx.setLineDash([]);
  gCtx.strokeStyle = '#93c5fd';
  gCtx.beginPath();
  gCtx.moveTo(0, 195);
  gCtx.lineTo(260, 195);
  gCtx.stroke();

  gCtx.strokeStyle = '#1e3a8a';
  gCtx.lineWidth = 5;
  gCtx.lineCap = 'round';
  gCtx.lineJoin = 'round';
  currentStrokes.forEach((s) => {
    if (s.length < 2) return;
    gCtx.beginPath();
    gCtx.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length; i++) gCtx.lineTo(s[i].x, s[i].y);
    gCtx.stroke();
  });
}

function getGlyphCanvasPoint(e) {
  const glyphCanvas = document.getElementById('glyphDrawCanvas');
  const rect = glyphCanvas.getBoundingClientRect();
  return {
    x: Math.round(((e.clientX - rect.left) * 260) / rect.width),
    y: Math.round(((e.clientY - rect.top) * 260) / rect.height),
  };
}

function clearGlyphCanvas() {
  currentStrokes = [];
  drawGlyphGuidelines();
}

function selectCharToTrain(ch) {
  state.activeChar = ch;
  document.getElementById('activeCharDisplay').textContent = ch;
  clearGlyphCanvas();
  renderAlphabetGrid();
  renderVariantsForChar(ch);
}

function saveGlyphVariant() {
  if (currentStrokes.length === 0) {
    showToast('Zeichne zuerst den Buchstaben!');
    return;
  }
  if (!state.glyphs[state.activeChar]) state.glyphs[state.activeChar] = [];
  state.glyphs[state.activeChar].push(JSON.parse(JSON.stringify(currentStrokes)));
  saveGlyphsToStorage();
  clearGlyphCanvas();
  renderAlphabetGrid();
  renderVariantsForChar(state.activeChar);
  showToast(`Variante für "${state.activeChar}" gespeichert`);
}

function deleteGlyphVariant(ch, idx) {
  if (!state.glyphs[ch]) return;
  state.glyphs[ch].splice(idx, 1);
  if (state.glyphs[ch].length === 0) delete state.glyphs[ch];
  saveGlyphsToStorage();
  renderAlphabetGrid();
  renderVariantsForChar(ch);
}

function renderAlphabetGrid() {
  const grid = document.getElementById('alphabetGrid');
  if (!grid) return;
  grid.innerHTML = CHAR_SET.map((ch, idx) => {
    const count = state.glyphs[ch]?.length || 0;
    const isActive = ch === state.activeChar;
    let cls = 'py-2 rounded-lg text-xs font-bold border transition ';
    if (isActive) cls += 'bg-[#2563eb] text-white border-blue-400';
    else if (count > 0) cls += 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60';
    else cls += 'bg-[#0f1117] text-gray-300 border-[#262a34] hover:border-gray-500';
    return `<button data-char-idx="${idx}" class="${cls}">${ch}${count > 1 ? `<span class="text-[9px] ml-0.5 opacity-80">${count}</span>` : ''}</button>`;
  }).join('');

  grid.querySelectorAll('[data-char-idx]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ch = CHAR_SET[parseInt(btn.getAttribute('data-char-idx'), 10)];
      if (ch !== undefined) selectCharToTrain(ch);
    });
  });
}

function renderVariantsForChar(ch) {
  const list = document.getElementById('charVariantsList');
  if (!list) return;
  const variants = state.glyphs[ch] || [];
  if (variants.length === 0) {
    list.innerHTML = `<div class="text-[11px] text-gray-500">Noch keine Variante für "${ch}" gespeichert.</div>`;
    return;
  }
  list.innerHTML =
    `<div class="text-[11px] text-gray-400 mb-1">Gespeicherte Varianten für "${ch}":</div>` +
    variants
      .map(
        (_, idx) => `
        <div class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-[#0f1117] border border-[#262a34] text-xs">
          <span class="text-gray-200">Variante #${idx + 1}</span>
          <button data-del-var="${idx}" class="text-red-400 hover:text-red-300 text-[11px]">Löschen</button>
        </div>`
      )
      .join('');

  list.querySelectorAll('[data-del-var]').forEach((btn) => {
    btn.addEventListener('click', () => {
      deleteGlyphVariant(ch, parseInt(btn.getAttribute('data-del-var'), 10));
    });
  });
}

function initEventBindings() {
  document.getElementById('mobileMenuOpenBtn')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('-translate-x-full');
    document.getElementById('mobileSidebarBackdrop')?.classList.remove('hidden');
  });
  document.getElementById('mobileMenuCloseBtn')?.addEventListener('click', closeMobileSidebar);
  document.getElementById('mobileSidebarBackdrop')?.addEventListener('click', closeMobileSidebar);

  document.getElementById('writeTextarea')?.addEventListener('input', handleControlChange);
  document.getElementById('fontSelect')?.addEventListener('change', handleControlChange);
  document.getElementById('paperSelect')?.addEventListener('change', handleControlChange);
  document.getElementById('notebookTitleInput')?.addEventListener('input', handleControlChange);
  document.getElementById('sliderFontSize')?.addEventListener('input', handleControlChange);
  document.getElementById('sliderLineHeight')?.addEventListener('input', handleControlChange);
  document.getElementById('sliderLetterSpacing')?.addEventListener('input', handleControlChange);
  document.getElementById('sliderMargin')?.addEventListener('input', handleControlChange);
  document.getElementById('exportModeSelect')?.addEventListener('change', (e) => {
    const cb = document.getElementById('editableFieldsCheckbox');
    if (cb && e.target.value === 'acroform-worksheet') {
      cb.checked = true;
    }
    handleControlChange();
  });
  document.getElementById('editableFieldsCheckbox')?.addEventListener('change', handleControlChange);

  document.getElementById('sheetFileInput')?.addEventListener('change', handleSheetFileUpload);
  document.getElementById('projectJsonInput')?.addEventListener('change', importProjectJson);

  // Selected box live editing
  document.getElementById('selectedBoxTextarea')?.addEventListener('input', (e) => {
    const sheet = getCurrentSheet();
    const box = sheet.textBoxes.find((b) => b.id === state.selectedBoxId);
    if (box) {
      box.text = e.target.value;
      renderPreview();
    }
  });
  document.getElementById('selectedBoxFontSize')?.addEventListener('input', (e) => {
    const sheet = getCurrentSheet();
    const box = sheet.textBoxes.find((b) => b.id === state.selectedBoxId);
    if (box) {
      box.fontSize = parseInt(e.target.value, 10);
      renderPreview();
    }
  });
  document.getElementById('deleteSelectedBoxBtn')?.addEventListener('click', () => {
    const sheet = getCurrentSheet();
    if (!state.selectedBoxId) return;
    pushSheetUndo();
    sheet.textBoxes = sheet.textBoxes.filter((b) => b.id !== state.selectedBoxId);
    state.selectedBoxId = null;
    renderPreview();
    showToast('Textbox gelöscht');
  });

  // Glyph canvas pointer events
  const glyphCanvas = document.getElementById('glyphDrawCanvas');
  if (glyphCanvas) {
    glyphCanvas.addEventListener('pointerdown', (e) => {
      isDrawingGlyph = true;
      activeStroke = [getGlyphCanvasPoint(e)];
      currentStrokes.push(activeStroke);
      drawGlyphGuidelines();
    });
    glyphCanvas.addEventListener('pointermove', (e) => {
      if (!isDrawingGlyph || !activeStroke) return;
      activeStroke.push(getGlyphCanvasPoint(e));
      drawGlyphGuidelines();
    });
    window.addEventListener('pointerup', () => {
      isDrawingGlyph = false;
      activeStroke = null;
    });
  }

  attachPreviewCanvasEvents();

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedBoxId) {
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      e.preventDefault();
      const sheet = getCurrentSheet();
      pushSheetUndo();
      sheet.textBoxes = sheet.textBoxes.filter((b) => b.id !== state.selectedBoxId);
      state.selectedBoxId = null;
      renderPreview();
      showToast('Textbox gelöscht');
    }
  });
}

// Expose handlers globally for clean declarative bindings
Object.assign(window, {
  setActiveView,
  clearWriteText,
  insertPageBreak,
  shuffleAllVariants,
  resetAppearance,
  setInkColor,
  removeCustomBackground,
  saveCurrentNotebook,
  exportNotabilityPdf,
  exportTransparentHandwritingPng,
  copyTransparentHandwritingPng,
  exportHandwritingTtf,
  exportHandwritingMobileConfig,
  exportProjectJson,
  changePreviewPage,
  setCanvasTool,
  undoSheetAction,
  addBlankSheet,
  deleteCurrentSheet,
  clearGlyphCanvas,
  saveGlyphVariant,
  handleControlChange,
});

loadStorage();
updateNotebookBadges();
updateTrainedCount();
initEventBindings();
drawGlyphGuidelines();
setCanvasTool('select');
handleControlChange();
if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    charWidthCache.clear();
    renderPreview();
  });
}
