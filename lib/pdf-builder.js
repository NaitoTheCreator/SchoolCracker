import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  TextRenderingMode,
  pushGraphicsState,
  popGraphicsState,
  setTextRenderingMode,
  rgb,
} from 'pdf-lib';
import {
  PAGE_W,
  PAGE_H,
  PDF_W_PT,
  PDF_H_PT,
  hexToRgbUnit,
  sanitizeWinAnsi,
  computeTextPages,
  layoutBoxText,
  transformGlyphStrokesToPagePoints,
} from './layout.js';

function dataUrlToUint8Array(dataUrl) {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) return new Uint8Array(0);
  const base64 = dataUrl.slice(commaIdx + 1);
  if (typeof atob === 'function') {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function addInkAnnotation(pdfDoc, page, polylinesPt, colorUnit, lineWidthPt, title = 'SchoolFucker') {
  const validLines = polylinesPt.filter((line) => Array.isArray(line) && line.length >= 2);
  if (validLines.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const line of validLines) {
    for (const pt of line) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }

  if (!Number.isFinite(minX)) return;

  const pad = Math.max(2, lineWidthPt * 1.5);
  const llx = minX - pad;
  const lly = minY - pad;
  const urx = maxX + pad;
  const ury = maxY + pad;
  const boxW = Math.max(1, urx - llx);
  const boxH = Math.max(1, ury - lly);

  const inkList = pdfDoc.context.obj(
    validLines.map((line) =>
      line.flatMap((pt) => [Number(pt.x.toFixed(2)), Number(pt.y.toFixed(2))])
    )
  );

  const commands = [
    'q',
    `${colorUnit.r.toFixed(3)} ${colorUnit.g.toFixed(3)} ${colorUnit.b.toFixed(3)} RG`,
    `${lineWidthPt.toFixed(2)} w`,
    '1 J',
    '1 j',
  ];

  for (const line of validLines) {
    commands.push(`${(line[0].x - llx).toFixed(2)} ${(line[0].y - lly).toFixed(2)} m`);
    for (let i = 1; i < line.length; i++) {
      commands.push(`${(line[i].x - llx).toFixed(2)} ${(line[i].y - lly).toFixed(2)} l`);
    }
    commands.push('S');
  }
  commands.push('Q');

  const streamBytes = new TextEncoder().encode(commands.join('\n'));
  const apStream = pdfDoc.context.flateStream(streamBytes, {
    Type: PDFName.of('XObject'),
    Subtype: PDFName.of('Form'),
    BBox: [0, 0, Number(boxW.toFixed(2)), Number(boxH.toFixed(2))],
    Resources: pdfDoc.context.obj({}),
  });
  const apRef = pdfDoc.context.register(apStream);

  const annotDict = pdfDoc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Ink'),
    Rect: [
      Number(llx.toFixed(2)),
      Number(lly.toFixed(2)),
      Number(urx.toFixed(2)),
      Number(ury.toFixed(2)),
    ],
    InkList: inkList,
    C: [colorUnit.r, colorUnit.g, colorUnit.b],
    BS: { W: Number(lineWidthPt.toFixed(2)), S: PDFName.of('S') },
    F: 4,
    T: PDFString.of(sanitizeWinAnsi(title)),
    AP: { N: apRef },
  });

  const annotRef = pdfDoc.context.register(annotDict);
  page.node.addAnnot(annotRef);
}

function drawContinuousVectorStrokes(page, polylinesPt, colorUnit, lineWidthPt) {
  const color = rgb(colorUnit.r, colorUnit.g, colorUnit.b);
  for (const line of polylinesPt) {
    if (!Array.isArray(line) || line.length < 2) continue;
    for (let i = 1; i < line.length; i++) {
      page.drawLine({
        start: { x: line[i - 1].x, y: line[i - 1].y },
        end: { x: line[i].x, y: line[i].y },
        thickness: lineWidthPt,
        color,
      });
    }
  }
}

function drawPaperVector(page, { paper, fontSize, lineHeight, margin, pageW, pageH }) {
  page.drawRectangle({
    x: 0,
    y: 0,
    width: pageW,
    height: pageH,
    color: rgb(1, 1, 1),
  });

  const scaleX = pageW / PAGE_W;
  const scaleY = pageH / PAGE_H;
  const gridColor = rgb(203 / 255, 213 / 255, 225 / 255);
  const marginLineColor = rgb(252 / 255, 165 / 255, 165 / 255);

  if (paper === 'grid') {
    const step = 19;
    for (let x = step; x < PAGE_W; x += step) {
      const px = x * scaleX;
      page.drawLine({
        start: { x: px, y: 0 },
        end: { x: px, y: pageH },
        thickness: 0.55,
        color: gridColor,
      });
    }
    for (let y = step; y < PAGE_H; y += step) {
      const py = pageH - y * scaleY;
      page.drawLine({
        start: { x: 0, y: py },
        end: { x: pageW, y: py },
        thickness: 0.55,
        color: gridColor,
      });
    }
    const marginX = 54 * scaleX;
    page.drawLine({
      start: { x: marginX, y: 0 },
      end: { x: marginX, y: pageH },
      thickness: 0.9,
      color: marginLineColor,
    });
  } else if (paper === 'lined') {
    const step = lineHeight;
    for (let y = margin + fontSize + 6; y < PAGE_H - 30; y += step) {
      const py = pageH - y * scaleY;
      page.drawLine({
        start: { x: 0, y: py },
        end: { x: pageW, y: py },
        thickness: 0.65,
        color: gridColor,
      });
    }
    const marginX = 54 * scaleX;
    page.drawLine({
      start: { x: marginX, y: 0 },
      end: { x: marginX, y: pageH },
      thickness: 0.9,
      color: marginLineColor,
    });
  }
}

export async function buildNotabilityPdf({
  text = '',
  font = 'my-script',
  paper = 'grid',
  title = 'Mein Heft',
  inkColor = '#1e3a8a',
  fontSize = 34,
  lineHeight = 46,
  letterSpacing = 0,
  margin = 64,
  seedOffset = 1,
  glyphs = {},
  customBgDataUrl = null,
  basePdfBytes = null,
  sheets = [],
  exportMode = 'notability-editable',
  editableTextFields = false,
  renderFallbackGlyphPng = null,
  measureCharWidth = null,
}) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(sanitizeWinAnsi(title || 'SchoolFucker'));
  pdfDoc.setCreator('SchoolFucker Notability PDF Studio');

  const baseFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const form = pdfDoc.getForm();

  let sourcePdf = null;
  if (basePdfBytes && basePdfBytes.byteLength > 0) {
    sourcePdf = await PDFDocument.load(basePdfBytes, { ignoreEncryption: true });
  }

  const flowPages = computeTextPages({
    text,
    font,
    fontSize,
    lineHeight,
    letterSpacing,
    margin,
    seedOffset,
    glyphs,
    measureCharWidth,
  });

  const totalPages = Math.max(flowPages.length, sheets.length, 1);
  const embeddedImagesCache = new Map();
  const glyphSpriteCache = new Map();

  async function embedImageFromDataUrl(dataUrl) {
    if (!dataUrl) return null;
    if (embeddedImagesCache.has(dataUrl)) return embeddedImagesCache.get(dataUrl);
    const bytes = dataUrlToUint8Array(dataUrl);
    if (bytes.length === 0) return null;
    let img = null;
    if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) {
      img = await pdfDoc.embedJpg(bytes);
    } else if (dataUrl.startsWith('data:image/png')) {
      img = await pdfDoc.embedPng(bytes);
    } else {
      // Fallback attempt PNG then JPG
      try {
        img = await pdfDoc.embedPng(bytes);
      } catch {
        img = await pdfDoc.embedJpg(bytes);
      }
    }
    embeddedImagesCache.set(dataUrl, img);
    return img;
  }

  const useInkAnnotations =
    exportMode === 'notability-editable' || exportMode === 'acroform-worksheet';
  const useEditableAcroFields =
    exportMode === 'acroform-worksheet' ||
    (exportMode === 'notability-editable' && editableTextFields);

  let fieldCounter = 0;

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const sheet = sheets[pageIdx] || {};
    const effectivePaper =
      sheet.paperOverride && sheet.paperOverride !== 'inherit' ? sheet.paperOverride : paper;

    let page;
    if (
      sourcePdf &&
      effectivePaper === 'imported-pdf' &&
      typeof sheet.importedPageIndex === 'number' &&
      sheet.importedPageIndex >= 0 &&
      sheet.importedPageIndex < sourcePdf.getPageCount()
    ) {
      const [copied] = await pdfDoc.copyPages(sourcePdf, [sheet.importedPageIndex]);
      page = pdfDoc.addPage(copied);
    } else {
      page = pdfDoc.addPage([PDF_W_PT, PDF_H_PT]);
      const bgUrl = sheet.customBgDataUrl || customBgDataUrl;
      if (effectivePaper === 'custom-png' && bgUrl) {
        page.drawRectangle({ x: 0, y: 0, width: PDF_W_PT, height: PDF_H_PT, color: rgb(1, 1, 1) });
        const img = await embedImageFromDataUrl(bgUrl);
        if (img) {
          page.drawImage(img, { x: 0, y: 0, width: PDF_W_PT, height: PDF_H_PT });
        }
      } else {
        drawPaperVector(page, {
          paper: effectivePaper === 'imported-pdf' ? 'blank' : effectivePaper,
          fontSize,
          lineHeight,
          margin,
          pageW: PDF_W_PT,
          pageH: PDF_H_PT,
        });
      }
    }

    const pageW = page.getWidth();
    const pageH = page.getHeight();
    const scaleX = pageW / PAGE_W;
    const scaleY = pageH / PAGE_H;

    const toPdfPt = (px, py) => ({
      x: px * scaleX,
      y: pageH - py * scaleY,
    });

    // Helper to render handwriting items (grouped into /Ink by wordId or crisp vector/sprite)
    const renderItemsAndLines = async ({ items, lines, boxFontSize, boxInkColor, asEditableField = false, boxBounds = null }) => {
      const colorUnit = hexToRgbUnit(boxInkColor || inkColor);
      const strokeWidthPt = Math.max(0.9, boxFontSize * 0.065 * scaleX);

      // 1) True PDF 3 Tr invisible searchable/selectable text layer for Notability Highlight & Search
      if (lines.length > 0) {
        page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
        for (const line of lines) {
          const clean = sanitizeWinAnsi(line.text);
          if (!clean.trim()) continue;
          const pos = toPdfPt(line.x, line.y);
          page.drawText(clean, {
            x: pos.x,
            y: pos.y,
            size: Math.max(8, line.fontSize * 0.72 * scaleY),
            font: baseFont,
            color: rgb(colorUnit.r, colorUnit.g, colorUnit.b),
          });
        }
        page.pushOperators(popGraphicsState());
      }

      // 2) If exported as an interactive AcroForm editable field (for placed text boxes / worksheet mode)
      if (asEditableField && boxBounds) {
        fieldCounter++;
        const tf = form.createTextField(`sf_field_${pageIdx + 1}_${fieldCounter}`);
        tf.enableMultiline();
        tf.setText(sanitizeWinAnsi(boxBounds.text || ''));
        const topPt = toPdfPt(boxBounds.x, boxBounds.y);
        const wPt = Math.max(40, boxBounds.width * scaleX);
        const hPt = Math.max(24, boxBounds.height * scaleY);
        tf.addToPage(page, {
          x: topPt.x,
          y: Math.max(8, topPt.y - hPt),
          width: wPt,
          height: hPt,
          borderWidth: exportMode === 'acroform-worksheet' ? 0.5 : 0,
          borderColor: rgb(0.75, 0.82, 0.94),
          textColor: rgb(colorUnit.r, colorUnit.g, colorUnit.b),
          font: baseFont,
        });
        tf.setFontSize(Math.max(9, Math.round(boxFontSize * 0.65 * scaleY)));
        return;
      }

      // 3) Render custom handwriting glyphs grouped by wordId
      const wordGroups = new Map();
      const fallbackItems = [];

      for (const item of items) {
        const customStrokes =
          font === 'my-script' && item.variantIdx >= 0 ? glyphs[item.ch]?.[item.variantIdx] : null;
        if (customStrokes && customStrokes.length > 0) {
          const polylinesPx = transformGlyphStrokesToPagePoints({
            strokes: customStrokes,
            itemX: item.x,
            itemY: item.y,
            rot: item.rot,
            size: boxFontSize,
            minX: item.minX,
          });
          const polylinesPt = polylinesPx.map((pl) => pl.map((p) => toPdfPt(p.x, p.y)));
          const key = item.wordId || 'word';
          if (!wordGroups.has(key)) wordGroups.set(key, []);
          wordGroups.get(key).push(...polylinesPt);
        } else {
          fallbackItems.push(item);
        }
      }

      for (const polylinesPt of wordGroups.values()) {
        if (useInkAnnotations) {
          addInkAnnotation(pdfDoc, page, polylinesPt, colorUnit, strokeWidthPt, title);
        } else {
          drawContinuousVectorStrokes(page, polylinesPt, colorUnit, strokeWidthPt);
        }
      }

      // 4) Render fallback items (Caveat / Patrick Hand / untrained chars) cleanly without pixel-rect spam
      for (const item of fallbackItems) {
        if (renderFallbackGlyphPng) {
          const cacheKey = `${font}|${item.ch}|${boxInkColor || inkColor}`;
          let sprite = glyphSpriteCache.get(cacheKey);
          if (!sprite) {
            const pngDataUrl = renderFallbackGlyphPng(item.ch, font, boxInkColor || inkColor);
            if (pngDataUrl) {
              const embedded = await embedImageFromDataUrl(pngDataUrl);
              sprite = embedded;
              glyphSpriteCache.set(cacheKey, sprite);
            }
          }
          if (sprite) {
            const spriteBoxPx = boxFontSize * 1.5;
            const drawOriginPxX = item.x - boxFontSize * 0.32;
            const drawOriginPxY = item.y + boxFontSize * 0.35;
            const pt = toPdfPt(drawOriginPxX, drawOriginPxY);
            page.drawImage(sprite, {
              x: pt.x,
              y: pt.y,
              width: spriteBoxPx * scaleX,
              height: spriteBoxPx * scaleY,
            });
            continue;
          }
        }

        // Pure vector text fallback (used in Node/headless environments or when no sprite renderer provided)
        const cleanCh = sanitizeWinAnsi(item.ch);
        if (cleanCh && cleanCh !== ' ') {
          const pos = toPdfPt(item.x, item.y);
          page.drawText(cleanCh, {
            x: pos.x,
            y: pos.y,
            size: boxFontSize * 0.78 * scaleY,
            font: baseFont,
            color: rgb(colorUnit.r, colorUnit.g, colorUnit.b),
          });
        }
      }
    };

    if (exportMode === 'template-only') {
      continue;
    }

    // Render flow text on this page
    const flowPage = flowPages[pageIdx];
    if (flowPage && (flowPage.items.length > 0 || flowPage.lines.length > 0)) {
      await renderItemsAndLines({
        items: flowPage.items,
        lines: flowPage.lines,
        boxFontSize: fontSize,
        boxInkColor: inkColor,
        asEditableField: false,
      });
    }

    // Render on-sheet placed TextBoxes
    const textBoxes = Array.isArray(sheet.textBoxes) ? sheet.textBoxes : [];
    for (let bIdx = 0; bIdx < textBoxes.length; bIdx++) {
      const box = textBoxes[bIdx];
      if (!box || (!box.text && exportMode !== 'acroform-worksheet')) continue;
      const boxFs = box.fontSize || fontSize;
      const boxLh = Math.round(boxFs * 1.32);
      const layout = layoutBoxText({
        text: box.text || '',
        font,
        x: box.x,
        y: box.y,
        width: box.width || 300,
        fontSize: boxFs,
        lineHeight: boxLh,
        letterSpacing,
        seedOffset,
        glyphs,
        seedBase: (pageIdx + 1) * 10000 + bIdx * 500,
        measureCharWidth,
      });

      await renderItemsAndLines({
        items: layout.items,
        lines: layout.lines,
        boxFontSize: boxFs,
        boxInkColor: box.inkColor || inkColor,
        asEditableField: useEditableAcroFields,
        boxBounds: {
          x: box.x,
          y: box.y,
          width: box.width || 300,
          height: layout.boxHeight,
          text: box.text || '',
        },
      });
    }

    // Render on-sheet whiteout / Tipp-Ex strokes as crisp white vector strokes
    const whiteoutStrokes = Array.isArray(sheet.whiteoutStrokes) ? sheet.whiteoutStrokes : [];
    for (const wStroke of whiteoutStrokes) {
      if (!wStroke || !Array.isArray(wStroke.points) || wStroke.points.length < 2) continue;
      const wWidthPt = Math.max(3, (wStroke.width || 18) * scaleX);
      const polylinePt = wStroke.points.map((pt) => toPdfPt(pt.x, pt.y));
      drawContinuousVectorStrokes(page, [polylinePt], { r: 1, g: 1, b: 1 }, wWidthPt);
    }

    // Render on-sheet freehand strokes
    const freehandStrokes = Array.isArray(sheet.strokes) ? sheet.strokes : [];
    for (const stroke of freehandStrokes) {
      if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) continue;
      const strokeColorUnit = hexToRgbUnit(stroke.color || inkColor);
      const strokeWidthPt = Math.max(0.8, (stroke.width || 3) * scaleX);
      const polylinePt = stroke.points.map((pt) => toPdfPt(pt.x, pt.y));

      if (useInkAnnotations) {
        addInkAnnotation(pdfDoc, page, [polylinePt], strokeColorUnit, strokeWidthPt, title);
      } else {
        drawContinuousVectorStrokes(page, [polylinePt], strokeColorUnit, strokeWidthPt);
      }
    }
  }

  try {
    form.updateFieldAppearances(baseFont);
  } catch {
    // Ignore if form has no fields
  }

  return await pdfDoc.save();
}
