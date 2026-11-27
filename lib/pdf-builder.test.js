import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import {
  computeTextPages,
  layoutBoxText,
  hitTestStroke,
  hitTestTextBox,
  sanitizeWinAnsi,
  transformGlyphStrokesToPagePoints,
  findFlowWordAtPoint,
  removeWordRangeFromText,
} from './layout.js';
import { buildNotabilityPdf } from './pdf-builder.js';
import * as opentypeNs from 'opentype.js';
import { buildHandwritingTtf, buildIosFontMobileConfig } from './font-builder.js';

const { parse: parseFont } = opentypeNs.parse ? opentypeNs : opentypeNs.default;

const SAMPLE_GLYPHS = {
  H: [[[{ x: 40, y: 40 }, { x: 40, y: 190 }], [{ x: 110, y: 40 }, { x: 110, y: 190 }], [{ x: 40, y: 115 }, { x: 110, y: 115 }]]],
  a: [[[{ x: 60, y: 120 }, { x: 100, y: 120 }, { x: 100, y: 185 }, { x: 60, y: 185 }]]],
  l: [[[{ x: 75, y: 45 }, { x: 75, y: 190 }]]],
  o: [[[{ x: 60, y: 120 }, { x: 100, y: 120 }, { x: 100, y: 185 }, { x: 60, y: 185 }, { x: 60, y: 120 }]]],
};

test('computeTextPages splits on ---SEITE--- and records line metadata', () => {
  const pages = computeTextPages({
    text: 'Hallo Welt\n---SEITE---\nZweite Seite äöüß',
    fontSize: 34,
    lineHeight: 46,
    letterSpacing: 1,
    margin: 64,
    seedOffset: 1,
    glyphs: SAMPLE_GLYPHS,
  });

  assert.equal(pages.length, 2);
  assert.equal(pages[0].lines.length, 1);
  assert.equal(pages[0].lines[0].text, 'Hallo Welt');
  assert.equal(pages[1].lines[0].text, 'Zweite Seite äöüß');
  assert.ok(pages[0].items.every((item) => typeof item.wordId === 'string'));
});

test('layoutBoxText wraps long text inside box width', () => {
  const res = layoutBoxText({
    text: 'Das ist ein längerer Antworttext auf einem Arbeitsblatt',
    x: 100,
    y: 200,
    width: 180,
    fontSize: 28,
    lineHeight: 38,
    letterSpacing: 1,
    seedOffset: 2,
    glyphs: SAMPLE_GLYPHS,
  });

  assert.ok(res.lines.length >= 2);
  assert.ok(res.boxHeight > 70);
});

test('hitTestStroke and hitTestTextBox detect hits accurately', () => {
  const stroke = {
    points: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ],
  };
  assert.equal(hitTestStroke(stroke, { x: 150, y: 105 }, 10), true);
  assert.equal(hitTestStroke(stroke, { x: 150, y: 130 }, 10), false);

  const box = { x: 100, y: 200, width: 220 };
  assert.deepEqual(hitTestTextBox(box, { x: 150, y: 220 }, 60), { hit: true, handle: 'move' });
  assert.deepEqual(hitTestTextBox(box, { x: 320, y: 260 }, 60), { hit: true, handle: 'resize' });
  assert.deepEqual(hitTestTextBox(box, { x: 500, y: 500 }, 60), { hit: false, handle: null });
});

test('sanitizeWinAnsi handles German punctuation and unsupported chars cleanly', () => {
  const cleaned = sanitizeWinAnsi('„Hallo“ – 10 € 🚀 äöüß');
  assert.equal(cleaned, '"Hallo" - 10 EUR ? äöüß');
});

test('transformGlyphStrokesToPagePoints produces valid page coordinates', () => {
  const pts = transformGlyphStrokesToPagePoints({
    strokes: SAMPLE_GLYPHS.H[0],
    itemX: 100,
    itemY: 200,
    rot: 0,
    size: 34,
  });
  assert.equal(pts.length, 3);
  assert.equal(pts[0].length, 2);
});

test('buildNotabilityPdf creates /Ink annotations with /AP streams and editable AcroForm fields', async () => {
  const bytes = await buildNotabilityPdf({
    text: 'Hallo',
    font: 'my-script',
    paper: 'grid',
    title: 'Mathe Blatt 1',
    inkColor: '#1e3a8a',
    glyphs: SAMPLE_GLYPHS,
    exportMode: 'notability-editable',
    editableTextFields: true,
    sheets: [
      {
        id: 's1',
        paperOverride: 'inherit',
        textBoxes: [
          {
            id: 'tb1',
            text: 'Antwort: 42 €',
            x: 120,
            y: 300,
            width: 240,
            fontSize: 28,
            inkColor: '#991b1b',
          },
        ],
        strokes: [
          {
            id: 'st1',
            color: '#1e3a8a',
            width: 3,
            points: [
              { x: 100, y: 500 },
              { x: 180, y: 510 },
              { x: 240, y: 495 },
            ],
          },
        ],
      },
    ],
  });

  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 1);

  const page = loaded.getPage(0);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  assert.ok(annots, 'Page should have Annots array');
  assert.ok(annots.size() >= 3, 'Should contain /Ink annotations and widget annotation');

  let inkCount = 0;
  let widgetCount = 0;
  for (let i = 0; i < annots.size(); i++) {
    const dict = loaded.context.lookup(annots.get(i));
    const subtype = dict.get(PDFName.of('Subtype'));
    if (subtype === PDFName.of('Ink')) {
      inkCount++;
      assert.ok(dict.get(PDFName.of('InkList')), '/Ink annotation must have InkList');
      assert.ok(dict.get(PDFName.of('AP')), '/Ink annotation must have /AP stream');
    } else if (subtype === PDFName.of('Widget')) {
      widgetCount++;
    }
  }

  assert.ok(inkCount >= 2, 'Should emit /Ink annotations for custom word and freehand stroke');
  assert.equal(widgetCount, 1, 'Should emit 1 editable AcroForm Widget for the text box');

  const form = loaded.getForm();
  const fields = form.getFields();
  assert.equal(fields.length, 1);
  assert.equal(fields[0].getText(), 'Antwort: 42 EUR');
});

test('buildNotabilityPdf preserves imported PDF pages and overlays annotations', async () => {
  const baseDoc = await PDFDocument.create();
  const p1 = baseDoc.addPage([595.28, 841.89]);
  p1.drawText('Arbeitsblatt Aufgabe 1', { x: 50, y: 780, size: 16 });
  const p2 = baseDoc.addPage([595.28, 841.89]);
  p2.drawText('Arbeitsblatt Aufgabe 2', { x: 50, y: 780, size: 16 });
  const baseBytes = await baseDoc.save();

  const outBytes = await buildNotabilityPdf({
    text: '',
    paper: 'imported-pdf',
    basePdfBytes: baseBytes,
    exportMode: 'acroform-worksheet',
    editableTextFields: true,
    sheets: [
      {
        id: 'imp-0',
        paperOverride: 'imported-pdf',
        importedPageIndex: 0,
        textBoxes: [{ id: 'tb-a', text: 'Lösung A', x: 100, y: 200, width: 200, fontSize: 24 }],
        strokes: [{ id: 'st-a', color: '#1e3a8a', width: 3, points: [{ x: 80, y: 280 }, { x: 220, y: 280 }] }],
      },
      {
        id: 'imp-1',
        paperOverride: 'imported-pdf',
        importedPageIndex: 1,
        textBoxes: [{ id: 'tb-b', text: 'Lösung B', x: 100, y: 240, width: 200, fontSize: 24 }],
        strokes: [],
      },
    ],
  });

  const loaded = await PDFDocument.load(outBytes);
  assert.equal(loaded.getPageCount(), 2);
  const form = loaded.getForm();
  assert.equal(form.getFields().length, 2);
});

test('proportional character spacing gives narrow chars smaller advance than wide chars', () => {
  const narrowPages = computeTextPages({
    text: 'iiii',
    font: 'caveat',
    fontSize: 34,
    letterSpacing: 0,
  });
  const widePages = computeTextPages({
    text: 'mmmm',
    font: 'caveat',
    fontSize: 34,
    letterSpacing: 0,
  });

  const narrowSpan =
    narrowPages[0].items[3].x - narrowPages[0].items[0].x;
  const wideSpan =
    widePages[0].items[3].x - widePages[0].items[0].x;

  assert.ok(narrowSpan < wideSpan * 0.55, `Expected 'iiii' span (${narrowSpan}) << 'mmmm' span (${wideSpan})`);

  const customPages = computeTextPages({
    text: 'lolo',
    font: 'my-script',
    fontSize: 34,
    letterSpacing: 0,
    glyphs: SAMPLE_GLYPHS,
  });
  assert.equal(customPages[0].items[0].minX, 75);
  assert.equal(customPages[0].items[1].minX, 60);
});

test('template-only mode exports clean background without Ink or Widget annotations', async () => {
  const outBytes = await buildNotabilityPdf({
    text: 'Soll nicht im Template stehen',
    font: 'my-script',
    paper: 'grid',
    glyphs: SAMPLE_GLYPHS,
    exportMode: 'template-only',
    sheets: [
      {
        id: 's1',
        paperOverride: 'inherit',
        textBoxes: [{ id: 'tb1', text: 'Box', x: 80, y: 120, width: 200, fontSize: 24 }],
        strokes: [{ id: 'st1', color: '#1e3a8a', width: 3, points: [{ x: 40, y: 40 }, { x: 120, y: 40 }] }],
      },
    ],
  });

  const loaded = await PDFDocument.load(outBytes);
  assert.equal(loaded.getPageCount(), 1);
  const page = loaded.getPage(0);
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  assert.equal(annots ? annots.size() : 0, 0);
});

test('findFlowWordAtPoint and removeWordRangeFromText erase clicked flow words cleanly', () => {
  const text = 'Hallo Welt Test';
  const pages = computeTextPages({
    text,
    font: 'caveat',
    fontSize: 34,
    letterSpacing: 0,
  });
  const secondWordItem = pages[0].items.find((it) => it.ch === 'W');
  assert.ok(secondWordItem);
  const hit = findFlowWordAtPoint(pages[0].items, { x: secondWordItem.x + 2, y: secondWordItem.y - 8 }, 34);
  assert.ok(hit);
  assert.equal(text.slice(hit.wordStart, hit.wordEnd), 'Welt');
  assert.equal(removeWordRangeFromText(text, hit.wordStart, hit.wordEnd), 'Hallo Test');
  assert.equal(removeWordRangeFromText('Einzel', 0, 6), '');
});

test('buildNotabilityPdf embeds whiteoutStrokes cleanly', async () => {
  const bytes = await buildNotabilityPdf({
    text: 'Test',
    paper: 'grid',
    sheets: [
      {
        id: 's1',
        textBoxes: [],
        strokes: [],
        whiteoutStrokes: [
          {
            id: 'wo1',
            color: '#ffffff',
            width: 18,
            points: [{ x: 60, y: 80 }, { x: 180, y: 80 }],
          },
        ],
      },
    ],
  });
  const loaded = await PDFDocument.load(bytes);
  assert.equal(loaded.getPageCount(), 1);
});

test('buildHandwritingTtf compiles trained glyphs into a valid TrueType glyf/loca TTF font', () => {
  const { arrayBuffer, glyphCount, familyName, postScriptName } = buildHandwritingTtf({
    familyName: 'Mein Heft 1',
    glyphs: {
      ...SAMPLE_GLYPHS,
      ä: [[[{ x: 60, y: 120 }, { x: 100, y: 185 }], [{ x: 70, y: 80 }]]],
    },
  });

  assert.equal(glyphCount, 5);
  assert.equal(familyName, 'Mein Heft 1');
  assert.equal(postScriptName, 'MeinHeft1-Regular');
  assert.ok(arrayBuffer.byteLength > 200);

  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, false), 0x00010000, 'SFNT header must be TrueType 0x00010000');

  const numTables = view.getUint16(4, false);
  const tags = [];
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    tags.push(tag);
  }
  assert.ok(tags.includes('glyf'), 'TrueType font must include glyf table');
  assert.ok(tags.includes('loca'), 'TrueType font must include loca table');
  assert.ok(!tags.includes('CFF '), 'TrueType font must not be CFF');

  // Verify whole-font OpenType checksum sums to 0xB1B0AFBA
  let wholeSum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    wholeSum = (wholeSum + view.getUint32(i, false)) >>> 0;
  }
  assert.equal(wholeSum, 0xb1b0afba, 'OpenType checkSumAdjustment must yield 0xB1B0AFBA');

  const parsed = parseFont(arrayBuffer);
  assert.equal(parsed.outlinesFormat, 'truetype');
  assert.equal(parsed.tables.os2.usWeightClass, 400);
  assert.equal(parsed.tables.os2.fsType, 0);
  assert.equal(parsed.names.windows.postScriptName.en, 'MeinHeft1-Regular');

  const glyphH = parsed.charToGlyph('H');
  assert.equal(glyphH.unicode, 72);
  assert.ok(glyphH.advanceWidth > 200);
  const bbox = glyphH.getBoundingBox();
  assert.ok(bbox.x2 > bbox.x1 && bbox.y2 > bbox.y1, 'Glyph H should have valid bounding box');

  const glyphAe = parsed.charToGlyph('ä');
  assert.equal(glyphAe.unicode, 228);
});

test('buildIosFontMobileConfig produces valid com.apple.font mobileconfig plist', () => {
  const { arrayBuffer, familyName, postScriptName } = buildHandwritingTtf({
    familyName: 'Englisch & Co',
    glyphs: SAMPLE_GLYPHS,
  });
  const xml = buildIosFontMobileConfig({ familyName, postScriptName, arrayBuffer });
  assert.ok(xml.includes('<string>com.apple.font</string>'));
  assert.ok(xml.includes(`<string>${postScriptName}.ttf</string>`));
  assert.ok(xml.includes('<key>Font</key>'));
  assert.ok(xml.includes('<data>'));
  assert.ok(xml.includes('Englisch  Co'));
  const expectedB64 = Buffer.from(new Uint8Array(arrayBuffer)).toString('base64');
  assert.ok(xml.includes(expectedB64));
});
