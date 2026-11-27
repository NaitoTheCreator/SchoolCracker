export const PAGE_W = 794;
export const PAGE_H = 1123;
export const PDF_W_PT = 595.28;
export const PDF_H_PT = 841.89;

const CHAR_WIDTH_RATIOS = {
  ' ': 0.28,
  i: 0.22,
  j: 0.25,
  l: 0.22,
  t: 0.28,
  f: 0.28,
  r: 0.32,
  I: 0.26,
  J: 0.36,
  '.': 0.2,
  ',': 0.2,
  ':': 0.22,
  ';': 0.22,
  '!': 0.24,
  '?': 0.42,
  "'": 0.18,
  '"': 0.32,
  '(': 0.28,
  ')': 0.28,
  '-': 0.32,
  '+': 0.44,
  '=': 0.44,
  '/': 0.34,
  m: 0.64,
  w: 0.62,
  M: 0.72,
  W: 0.74,
  G: 0.56,
  O: 0.56,
  Q: 0.58,
  Ö: 0.56,
  Ä: 0.54,
  Ü: 0.54,
  ß: 0.48,
};

export function seededRandom(index, seedOffset = 1) {
  const x = Math.sin((index + 1) * 9301 + seedOffset * 49297) * 233280;
  return x - Math.floor(x);
}

export function hexToRgb(hex) {
  const clean = (hex || '#1e3a8a').replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) {
    return { r: 30, g: 58, b: 138 };
  }
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

export function hexToRgbUnit(hex) {
  const { r, g, b } = hexToRgb(hex);
  return { r: r / 255, g: g / 255, b: b / 255 };
}

const WINANSI_MAP = {
  '„': '"',
  '“': '"',
  '”': '"',
  '‚': "'",
  '‘': "'",
  '’': "'",
  '–': '-',
  '—': '-',
  '…': '...',
  '€': 'EUR',
  '•': '*',
  '\u00A0': ' ',
};

export function sanitizeWinAnsi(text) {
  if (!text) return '';
  let out = '';
  for (const ch of String(text)) {
    if (WINANSI_MAP[ch] !== undefined) {
      out += WINANSI_MAP[ch];
      continue;
    }
    const code = ch.charCodeAt(0);
    if (
      code === 10 ||
      code === 13 ||
      code === 9 ||
      (code >= 32 && code <= 126) ||
      (code >= 160 && code <= 255)
    ) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

export function getGlyphHorizontalMetrics(strokes) {
  if (!Array.isArray(strokes) || strokes.length === 0) {
    return { minX: 40, maxX: 110, span: 70 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  for (const stroke of strokes) {
    if (!Array.isArray(stroke)) continue;
    for (const pt of stroke) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    return { minX: 40, maxX: 110, span: 70 };
  }
  return { minX, maxX, span: Math.max(8, maxX - minX) };
}

export function getProportionalCharAdvance(
  ch,
  { font = 'my-script', fontSize = 34, variantStrokes = null, measureCharWidth = null }
) {
  if (ch === ' ') return fontSize * 0.28;
  if (ch === '\t') return fontSize * 0.56;

  if (font === 'my-script' && Array.isArray(variantStrokes) && variantStrokes.length > 0) {
    const { span } = getGlyphHorizontalMetrics(variantStrokes);
    const scale = fontSize / 145;
    return Math.max(fontSize * 0.18, span * scale + fontSize * 0.09);
  }

  if (typeof measureCharWidth === 'function') {
    const measured = measureCharWidth(ch, font, fontSize);
    if (Number.isFinite(measured) && measured > 0) {
      return Math.max(fontSize * 0.16, measured);
    }
  }

  if (CHAR_WIDTH_RATIOS[ch] !== undefined) {
    return fontSize * CHAR_WIDTH_RATIOS[ch];
  }
  if (ch >= 'A' && ch <= 'Z') {
    return fontSize * 0.5;
  }
  if (ch >= '0' && ch <= '9') {
    return fontSize * 0.44;
  }
  return fontSize * 0.42;
}

function measureTokenWidth(token, { font, fontSize, letterSpacing, glyphs, measureCharWidth }) {
  let total = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    const variants = glyphs?.[ch];
    const variantStrokes = font === 'my-script' && variants?.length > 0 ? variants[0] : null;
    total += getProportionalCharAdvance(ch, { font, fontSize, variantStrokes, measureCharWidth }) + letterSpacing;
  }
  return total;
}

export function computeTextPages({
  text = '',
  font = 'my-script',
  fontSize = 34,
  lineHeight = 46,
  letterSpacing = 0,
  margin = 64,
  seedOffset = 1,
  glyphs = {},
  measureCharWidth = null,
}) {
  const maxX = PAGE_W - margin;
  const maxY = PAGE_H - margin;
  const rawBlocks = String(text).split('---SEITE---');
  const pages = [];

  let blockBaseOffset = 0;
  rawBlocks.forEach((blockText, bIdx) => {
    let items = [];
    let linesMeta = [];
    let x = margin;
    let y = margin + fontSize;
    let charCounter = bIdx * 500;
    let wordCounter = bIdx * 200;

    let currentLineText = '';
    let currentLineStartX = margin;
    let currentLineY = y;

    const flushLine = () => {
      if (currentLineText.trim().length > 0) {
        linesMeta.push({
          text: currentLineText,
          x: currentLineStartX,
          y: currentLineY,
          width: Math.max(20, x - currentLineStartX),
          fontSize,
        });
      }
      currentLineText = '';
    };

    const advanceLine = () => {
      flushLine();
      x = margin;
      y += lineHeight;
      currentLineStartX = x;
      currentLineY = y;
      if (y > maxY) {
        pages.push({ items, lines: linesMeta });
        items = [];
        linesMeta = [];
        y = margin + fontSize;
        currentLineY = y;
      }
    };

    const rawLines = blockText.split('\n');
    let lineBaseOffset = blockBaseOffset;
    rawLines.forEach((line, lIdx) => {
      const tokens = line.split(/(\s+)/);
      let tokenOffset = lineBaseOffset;
      tokens.forEach((token) => {
        if (token === '') return;
        const isSpace = /^\s+$/.test(token);
        const tokenStart = tokenOffset;
        const tokenEnd = tokenOffset + token.length;
        tokenOffset = tokenEnd;
        const tokenWidth = measureTokenWidth(token, {
          font,
          fontSize,
          letterSpacing,
          glyphs,
          measureCharWidth,
        });

        if (!isSpace && x + tokenWidth > maxX && x > margin) {
          advanceLine();
        }

        if (!isSpace) {
          wordCounter++;
        }

        for (let i = 0; i < token.length; i++) {
          const ch = token[i];
          charCounter++;

          const variants = glyphs?.[ch];
          const variantIdx =
            variants && variants.length > 0
              ? Math.floor(seededRandom(charCounter + 19, seedOffset) * variants.length)
              : -1;
          const variantStrokes =
            font === 'my-script' && variantIdx >= 0 ? variants[variantIdx] : null;

          const adv = getProportionalCharAdvance(ch, {
            font,
            fontSize,
            variantStrokes,
            measureCharWidth,
          });

          if (ch === ' ') {
            currentLineText += ' ';
            x += adv + letterSpacing * 0.5;
            continue;
          }
          if (ch === '\t') {
            currentLineText += '  ';
            x += adv + letterSpacing;
            continue;
          }

          if (!isSpace && x + adv > maxX && x > margin) {
            advanceLine();
          }

          const jitterY = (seededRandom(charCounter, seedOffset) - 0.5) * 2.2;
          const jitterRot = (seededRandom(charCounter + 77, seedOffset) - 0.5) * 0.05;
          const glyphMetrics = variantStrokes ? getGlyphHorizontalMetrics(variantStrokes) : null;

          items.push({
            ch,
            x,
            y: y + jitterY,
            rot: jitterRot,
            variantIdx,
            minX: glyphMetrics ? glyphMetrics.minX : null,
            wordId: `w-${bIdx}-${wordCounter}`,
            wordStart: isSpace ? null : tokenStart,
            wordEnd: isSpace ? null : tokenEnd,
          });
          currentLineText += ch;
          x += Math.max(fontSize * 0.12, adv + letterSpacing);
        }
      });

      lineBaseOffset += line.length + 1;
      if (lIdx < rawLines.length - 1) {
        advanceLine();
      }
    });

    flushLine();
    pages.push({ items, lines: linesMeta });
    blockBaseOffset += blockText.length + '---SEITE---'.length;
  });

  if (pages.length === 0) pages.push({ items: [], lines: [] });
  return pages;
}

export function layoutBoxText({
  text = '',
  font = 'my-script',
  x = 80,
  y = 120,
  width = 320,
  fontSize = 30,
  lineHeight = 40,
  letterSpacing = 0,
  seedOffset = 1,
  glyphs = {},
  seedBase = 10000,
  measureCharWidth = null,
}) {
  const maxX = x + Math.max(80, width);
  const items = [];
  const linesMeta = [];
  const rawLines = String(text).split('\n');

  let curX = x;
  let curY = y + fontSize;
  let charCounter = seedBase;
  let wordCounter = seedBase;
  let currentLineText = '';

  const flushLine = () => {
    if (currentLineText.trim().length > 0) {
      linesMeta.push({
        text: currentLineText,
        x,
        y: curY,
        width: Math.max(40, curX - x),
        fontSize,
      });
    }
    currentLineText = '';
  };

  rawLines.forEach((line, lIdx) => {
    const tokens = line.split(/(\s+)/);
    tokens.forEach((token) => {
      if (token === '') return;
      const isSpace = /^\s+$/.test(token);
      const tokenWidth = measureTokenWidth(token, {
        font,
        fontSize,
        letterSpacing,
        glyphs,
        measureCharWidth,
      });

      if (!isSpace && curX + tokenWidth > maxX && curX > x) {
        flushLine();
        curX = x;
        curY += lineHeight;
      }

      if (!isSpace) wordCounter++;

      for (let i = 0; i < token.length; i++) {
        const ch = token[i];
        charCounter++;

        const variants = glyphs?.[ch];
        const variantIdx =
          variants && variants.length > 0
            ? Math.floor(seededRandom(charCounter + 19, seedOffset) * variants.length)
            : -1;
        const variantStrokes =
          font === 'my-script' && variantIdx >= 0 ? variants[variantIdx] : null;
        const adv = getProportionalCharAdvance(ch, {
          font,
          fontSize,
          variantStrokes,
          measureCharWidth,
        });

        if (ch === ' ') {
          currentLineText += ' ';
          curX += adv + letterSpacing * 0.5;
          continue;
        }

        if (!isSpace && curX + adv > maxX && curX > x) {
          flushLine();
          curX = x;
          curY += lineHeight;
        }

        const jitterY = (seededRandom(charCounter, seedOffset) - 0.5) * 1.8;
        const jitterRot = (seededRandom(charCounter + 77, seedOffset) - 0.5) * 0.045;
        const glyphMetrics = variantStrokes ? getGlyphHorizontalMetrics(variantStrokes) : null;

        items.push({
          ch,
          x: curX,
          y: curY + jitterY,
          rot: jitterRot,
          variantIdx,
          minX: glyphMetrics ? glyphMetrics.minX : null,
          wordId: `box-${seedBase}-${wordCounter}`,
        });
        currentLineText += ch;
        curX += Math.max(fontSize * 0.12, adv + letterSpacing);
      }
    });

    if (lIdx < rawLines.length - 1) {
      flushLine();
      curX = x;
      curY += lineHeight;
    }
  });

  flushLine();
  const numLines = Math.max(1, Math.round((curY - (y + fontSize)) / lineHeight) + 1);
  const boxHeight = Math.max(lineHeight + 12, numLines * lineHeight + 10);

  return { items, lines: linesMeta, boxHeight };
}

export function transformGlyphStrokesToPagePoints({
  strokes,
  itemX,
  itemY,
  rot = 0,
  size = 34,
  minX = null,
}) {
  if (!Array.isArray(strokes)) return [];
  const scale = size / 145;
  const resolvedMinX =
    typeof minX === 'number' ? minX : getGlyphHorizontalMetrics(strokes).minX;
  const drawX = itemX - resolvedMinX * scale + size * 0.03;
  const drawY = itemY - size * 0.98;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  const out = [];
  for (const stroke of strokes) {
    if (!Array.isArray(stroke) || stroke.length < 2) continue;
    const pts = [];
    for (const pt of stroke) {
      const px = drawX + pt.x * scale;
      const py = drawY + pt.y * scale;
      const dx = px - itemX;
      const dy = py - itemY;
      pts.push({
        x: itemX + dx * cos - dy * sin,
        y: itemY + dx * sin + dy * cos,
      });
    }
    out.push(pts);
  }
  return out;
}

function pointToSegmentDistSq(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const ex = p.x - projX;
  const ey = p.y - projY;
  return ex * ex + ey * ey;
}

export function hitTestStroke(stroke, point, threshold = 12) {
  const pts = stroke?.points;
  if (!Array.isArray(pts) || pts.length === 0) return false;
  const threshSq = threshold * threshold;
  if (pts.length === 1) {
    const dx = point.x - pts[0].x;
    const dy = point.y - pts[0].y;
    return dx * dx + dy * dy <= threshSq;
  }
  for (let i = 1; i < pts.length; i++) {
    if (pointToSegmentDistSq(point, pts[i - 1], pts[i]) <= threshSq) {
      return true;
    }
  }
  return false;
}

export function hitTestTextBox(box, point, boxHeight) {
  if (!box) return { hit: false, handle: null };
  const pad = 6;
  const rx = box.x + box.width;
  const ry = box.y + boxHeight;
  if (Math.abs(point.x - rx) <= 12 && Math.abs(point.y - ry) <= 12) {
    return { hit: true, handle: 'resize' };
  }
  if (
    point.x >= box.x - pad &&
    point.x <= box.x + box.width + pad &&
    point.y >= box.y - pad &&
    point.y <= box.y + boxHeight + pad
  ) {
    return { hit: true, handle: 'move' };
  }
  return { hit: false, handle: null };
}

export function findFlowWordAtPoint(items, point, fontSize = 34) {
  if (!Array.isArray(items) || !point) return null;
  const padX = Math.max(3, fontSize * 0.1);
  const topOffset = fontSize * 0.92;
  const bottomOffset = fontSize * 0.25;
  let best = null;
  let bestDistSq = Infinity;
  for (const item of items) {
    if (typeof item.wordStart !== 'number' || typeof item.wordEnd !== 'number') continue;
    const minX = item.x - padX;
    const maxX = item.x + fontSize * 0.5 + padX;
    const minY = item.y - topOffset;
    const maxY = item.y + bottomOffset;
    if (point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY) {
      const cx = item.x + fontSize * 0.22;
      const cy = item.y - fontSize * 0.35;
      const dx = point.x - cx;
      const dy = point.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDistSq) {
        bestDistSq = d2;
        best = {
          wordId: item.wordId,
          wordStart: item.wordStart,
          wordEnd: item.wordEnd,
        };
      }
    }
  }
  return best;
}

export function removeWordRangeFromText(text, start, end) {
  const str = String(text || '');
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end <= start || end > str.length) {
    return str;
  }
  let removeStart = start;
  let removeEnd = end;
  if (str[removeEnd] === ' ' || str[removeEnd] === '\t') {
    removeEnd += 1;
  } else if (removeStart > 0 && (str[removeStart - 1] === ' ' || str[removeStart - 1] === '\t')) {
    removeStart -= 1;
  }
  return str.slice(0, removeStart) + str.slice(removeEnd);
}
