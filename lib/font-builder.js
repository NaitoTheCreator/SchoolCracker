import { getGlyphHorizontalMetrics, sanitizeWinAnsi } from './layout.js';

function createCircleContour(cx, cy, r, steps = 10) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (-2 * Math.PI * i) / steps;
    pts.push({
      x: Math.round(cx + r * Math.cos(a)),
      y: Math.round(cy + r * Math.sin(a)),
    });
  }
  return dedupeContour(pts);
}

function createCapsuleContour(x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    return createCircleContour(x1, y1, r);
  }

  const baseAngle = Math.atan2(dy, dx);
  const capSteps = 4;
  const pts = [];

  for (let i = 0; i <= capSteps; i++) {
    const a = baseAngle + Math.PI / 2 - (Math.PI * i) / capSteps;
    pts.push({
      x: Math.round(x2 + r * Math.cos(a)),
      y: Math.round(y2 + r * Math.sin(a)),
    });
  }

  for (let i = 0; i <= capSteps; i++) {
    const a = baseAngle - Math.PI / 2 - (Math.PI * i) / capSteps;
    pts.push({
      x: Math.round(x1 + r * Math.cos(a)),
      y: Math.round(y1 + r * Math.sin(a)),
    });
  }

  return dedupeContour(pts);
}

function dedupeContour(pts) {
  const out = [];
  for (const pt of pts) {
    const prev = out[out.length - 1];
    if (!prev || prev.x !== pt.x || prev.y !== pt.y) {
      out.push(pt);
    }
  }
  if (out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) {
    out.pop();
  }
  return out;
}

class BinaryWriter {
  constructor(initialSize = 1024) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  ensure(extra) {
    if (this.pos + extra <= this.buf.length) return;
    let nextLen = this.buf.length * 2;
    while (nextLen < this.pos + extra) nextLen *= 2;
    const next = new Uint8Array(nextLen);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  u16(v) {
    this.ensure(2);
    this.view.setUint16(this.pos, v >>> 0, false);
    this.pos += 2;
  }

  i16(v) {
    this.ensure(2);
    this.view.setInt16(this.pos, v | 0, false);
    this.pos += 2;
  }

  u32(v) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, false);
    this.pos += 4;
  }

  i32(v) {
    this.ensure(4);
    this.view.setInt32(this.pos, v | 0, false);
    this.pos += 4;
  }

  tag(str) {
    for (let i = 0; i < 4; i++) {
      this.u8(str.charCodeAt(i) || 32);
    }
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
  }

  longDateTime(unixSec) {
    const macSec = BigInt(Math.floor(unixSec)) + 2082844800n;
    const hi = Number((macSec >> 32n) & 0xffffffffn);
    const lo = Number(macSec & 0xffffffffn);
    this.u32(hi);
    this.u32(lo);
  }

  pad4() {
    while (this.pos % 4 !== 0) this.u8(0);
  }

  toUint8Array() {
    return this.buf.slice(0, this.pos);
  }
}

function calcTableChecksum(bytes) {
  const paddedLen = Math.ceil(bytes.length / 4) * 4;
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );
  let sum = 0;
  for (let i = 0; i < paddedLen; i += 4) {
    let word = 0;
    if (i + 4 <= bytes.length) {
      word = view.getUint32(i, false);
    } else {
      for (let b = 0; b < 4; b++) {
        word = (word << 8) | (i + b < bytes.length ? bytes[i + b] : 0);
      }
      word = word >>> 0;
    }
    sum = (sum + word) >>> 0;
  }
  return sum >>> 0;
}

function encodeSimpleGlyf(contours) {
  if (!contours || contours.length === 0) {
    return {
      bytes: new Uint8Array(0),
      xMin: 0,
      yMin: 0,
      xMax: 0,
      yMax: 0,
      numPoints: 0,
      numContours: 0,
    };
  }

  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  const allPts = [];
  const endPts = [];

  for (const contour of contours) {
    if (!contour || contour.length < 3) continue;
    for (const pt of contour) {
      const x = Math.round(pt.x);
      const y = Math.round(pt.y);
      if (x < xMin) xMin = x;
      if (y < yMin) yMin = y;
      if (x > xMax) xMax = x;
      if (y > yMax) yMax = y;
      allPts.push({ x, y });
    }
    endPts.push(allPts.length - 1);
  }

  if (endPts.length === 0 || allPts.length === 0) {
    return {
      bytes: new Uint8Array(0),
      xMin: 0,
      yMin: 0,
      xMax: 0,
      yMax: 0,
      numPoints: 0,
      numContours: 0,
    };
  }

  const w = new BinaryWriter(64 + allPts.length * 5);
  w.i16(endPts.length);
  w.i16(xMin);
  w.i16(yMin);
  w.i16(xMax);
  w.i16(yMax);

  for (const endIdx of endPts) {
    w.u16(endIdx);
  }
  w.u16(0); // instructionLength

  // Uncompressed on-curve flags (0x01) + signed 16-bit delta coordinates
  for (let i = 0; i < allPts.length; i++) {
    w.u8(0x01);
  }

  let prevX = 0;
  for (const pt of allPts) {
    w.i16(pt.x - prevX);
    prevX = pt.x;
  }

  let prevY = 0;
  for (const pt of allPts) {
    w.i16(pt.y - prevY);
    prevY = pt.y;
  }

  w.pad4();
  return {
    bytes: w.toUint8Array(),
    xMin,
    yMin,
    xMax,
    yMax,
    numPoints: allPts.length,
    numContours: endPts.length,
  };
}

function buildCmapTable(codeMapEntries) {
  // codeMapEntries: sorted array of { code, glyphId } with 0 <= code <= 0xFFFE
  const segments = [];
  for (const entry of codeMapEntries) {
    const prev = segments[segments.length - 1];
    if (
      prev &&
      entry.code === prev.endCode + 1 &&
      entry.glyphId === prev.endGlyphId + 1
    ) {
      prev.endCode = entry.code;
      prev.endGlyphId = entry.glyphId;
    } else {
      segments.push({
        startCode: entry.code,
        endCode: entry.code,
        startGlyphId: entry.glyphId,
        endGlyphId: entry.glyphId,
      });
    }
  }
  // Mandatory terminating sentinel segment
  segments.push({
    startCode: 0xffff,
    endCode: 0xffff,
    startGlyphId: 0,
    endGlyphId: 0,
    isSentinel: true,
  });

  const segCount = segments.length;
  const segCountX2 = segCount * 2;
  const maxPow2 = 1 << Math.floor(Math.log2(segCount));
  const searchRange = maxPow2 * 2;
  const entrySelector = Math.floor(Math.log2(segCount));
  const rangeShift = segCountX2 - searchRange;
  const subtableLength = 16 + segCount * 8;

  const w = new BinaryWriter(24 + subtableLength);
  // cmap header: 2 encoding records (Unicode 2.0 BMP + Windows Unicode BMP)
  w.u16(0); // version
  w.u16(2); // numTables
  w.u16(0); // platformID = Unicode
  w.u16(3); // encodingID = Unicode 2.0+ BMP
  w.u32(20); // offset to format 4 subtable
  w.u16(3); // platformID = Windows
  w.u16(1); // encodingID = Unicode BMP
  w.u32(20); // offset to format 4 subtable

  // Format 4 subtable
  w.u16(4); // format
  w.u16(subtableLength);
  w.u16(0); // language
  w.u16(segCountX2);
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(rangeShift);

  for (const seg of segments) w.u16(seg.endCode);
  w.u16(0); // reservedPad
  for (const seg of segments) w.u16(seg.startCode);
  for (const seg of segments) {
    const delta = seg.isSentinel ? 1 : (seg.startGlyphId - seg.startCode) & 0xffff;
    w.i16((delta << 16) >> 16);
  }
  for (let i = 0; i < segments.length; i++) {
    w.u16(0); // idRangeOffset
  }

  return w.toUint8Array();
}

function encodeAsciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i] = code >= 0x20 && code <= 0x7e ? code : 0x3f;
  }
  return out;
}

function encodeUtf16BeBytes(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function buildNameTable({ familyName, postScriptName }) {
  const entries = [
    { nameID: 0, text: 'SchoolFucker Handschrift' },
    { nameID: 1, text: familyName },
    { nameID: 2, text: 'Regular' },
    { nameID: 3, text: `SchoolFucker:${postScriptName}:1.0` },
    { nameID: 4, text: familyName },
    { nameID: 5, text: 'Version 1.0' },
    { nameID: 6, text: postScriptName },
  ];

  const records = [];
  for (const e of entries) {
    records.push({
      platformID: 1,
      encodingID: 0,
      languageID: 0,
      nameID: e.nameID,
      bytes: encodeAsciiBytes(e.text),
    });
    records.push({
      platformID: 3,
      encodingID: 1,
      languageID: 0x0409,
      nameID: e.nameID,
      bytes: encodeUtf16BeBytes(e.text),
    });
  }

  records.sort(
    (a, b) =>
      a.platformID - b.platformID ||
      a.encodingID - b.encodingID ||
      a.languageID - b.languageID ||
      a.nameID - b.nameID
  );

  const stringOffset = 6 + records.length * 12;
  let strLen = 0;
  for (const r of records) strLen += r.bytes.length;

  const w = new BinaryWriter(stringOffset + strLen + 16);
  w.u16(0); // format
  w.u16(records.length);
  w.u16(stringOffset);

  let cursor = 0;
  for (const r of records) {
    w.u16(r.platformID);
    w.u16(r.encodingID);
    w.u16(r.languageID);
    w.u16(r.nameID);
    w.u16(r.bytes.length);
    w.u16(cursor);
    cursor += r.bytes.length;
  }

  for (const r of records) {
    w.bytes(r.bytes);
  }

  return w.toUint8Array();
}

function buildPostTable(glyphList) {
  const w = new BinaryWriter(256 + glyphList.length * 12);
  w.u32(0x00020000); // version 2.0
  w.i32(0); // italicAngle
  w.i16(-100); // underlinePosition
  w.i16(50); // underlineThickness
  w.u32(0); // isFixedPitch
  w.u32(0); // minMemType42
  w.u32(0); // maxMemType42
  w.u32(0); // minMemType1
  w.u32(0); // maxMemType1

  w.u16(glyphList.length);
  const extraNames = [];
  for (const g of glyphList) {
    if (g.name === '.notdef') {
      w.u16(0);
    } else if (g.name === 'space') {
      w.u16(3);
    } else {
      w.u16(258 + extraNames.length);
      extraNames.push(g.name);
    }
  }

  for (const name of extraNames) {
    const ascii = encodeAsciiBytes(name.slice(0, 63));
    w.u8(ascii.length);
    w.bytes(ascii);
  }

  return w.toUint8Array();
}

export function buildHandwritingTtf({
  familyName = 'MeineHandschrift',
  glyphs = {},
  strokeRadius = 24,
}) {
  const unitsPerEm = 1000;
  const scale = 5.6;
  const baselineCanvasY = 195;
  const lsb = 55;
  const rsb = 55;

  // Glyph 0: .notdef (outer clockwise box + inner CCW cutout)
  const notdefContours = [
    [
      { x: 80, y: 0 },
      { x: 80, y: 680 },
      { x: 520, y: 680 },
      { x: 520, y: 0 },
    ],
    [
      { x: 140, y: 60 },
      { x: 460, y: 60 },
      { x: 460, y: 620 },
      { x: 140, y: 620 },
    ],
  ];

  const glyphRecords = [
    {
      name: '.notdef',
      unicode: null,
      advanceWidth: 600,
      encoded: encodeSimpleGlyf(notdefContours),
    },
    {
      name: 'space',
      unicode: 32,
      advanceWidth: 280,
      encoded: encodeSimpleGlyf([]),
    },
  ];

  const seenCodePoints = new Set([0, 32, 160]);

  for (const [ch, variants] of Object.entries(glyphs || {})) {
    if (!ch || ch.length !== 1) continue;
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const strokes = variants[0];
    if (!Array.isArray(strokes) || strokes.length === 0) continue;

    const code = ch.charCodeAt(0);
    if (code <= 0 || code >= 0xffff || seenCodePoints.has(code)) continue;
    seenCodePoints.add(code);

    const { minX, span } = getGlyphHorizontalMetrics(strokes);
    const contours = [];

    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length === 0) continue;
      if (stroke.length === 1) {
        const fx = (stroke[0].x - minX) * scale + lsb;
        const fy = (baselineCanvasY - stroke[0].y) * scale;
        const c = createCircleContour(fx, fy, strokeRadius);
        if (c.length >= 3) contours.push(c);
        continue;
      }
      for (let i = 1; i < stroke.length; i++) {
        const p0 = stroke[i - 1];
        const p1 = stroke[i];
        const x1 = (p0.x - minX) * scale + lsb;
        const y1 = (baselineCanvasY - p0.y) * scale;
        const x2 = (p1.x - minX) * scale + lsb;
        const y2 = (baselineCanvasY - p1.y) * scale;
        const c = createCapsuleContour(x1, y1, x2, y2, strokeRadius);
        if (c.length >= 3) contours.push(c);
      }
    }

    const advanceWidth = Math.max(220, Math.round(span * scale + lsb + rsb));
    glyphRecords.push({
      name: `uni${code.toString(16).toUpperCase().padStart(4, '0')}`,
      unicode: code,
      advanceWidth,
      encoded: encodeSimpleGlyf(contours),
    });
  }

  // Global metrics across all glyphs
  let globalXMin = Infinity;
  let globalYMin = Infinity;
  let globalXMax = -Infinity;
  let globalYMax = -Infinity;
  let advanceWidthMax = 0;
  let minLeftSideBearing = Infinity;
  let minRightSideBearing = Infinity;
  let xMaxExtent = -Infinity;
  let maxPoints = 0;
  let maxContours = 0;
  let advWidthSum = 0;
  let advWidthCount = 0;
  let hasLatin1Supplement = false;

  for (const g of glyphRecords) {
    if (g.advanceWidth > advanceWidthMax) advanceWidthMax = g.advanceWidth;
    if (g.advanceWidth > 0) {
      advWidthSum += g.advanceWidth;
      advWidthCount++;
    }
    const e = g.encoded;
    if (e.numPoints > maxPoints) maxPoints = e.numPoints;
    if (e.numContours > maxContours) maxContours = e.numContours;
    if (e.bytes.length > 0) {
      if (e.xMin < globalXMin) globalXMin = e.xMin;
      if (e.yMin < globalYMin) globalYMin = e.yMin;
      if (e.xMax > globalXMax) globalXMax = e.xMax;
      if (e.yMax > globalYMax) globalYMax = e.yMax;
      if (e.xMin < minLeftSideBearing) minLeftSideBearing = e.xMin;
      const rsbVal = g.advanceWidth - e.xMax;
      if (rsbVal < minRightSideBearing) minRightSideBearing = rsbVal;
      if (e.xMax > xMaxExtent) xMaxExtent = e.xMax;
    }
    if (g.unicode !== null && g.unicode >= 0x80 && g.unicode <= 0xff) {
      hasLatin1Supplement = true;
    }
  }

  if (!Number.isFinite(globalXMin)) {
    globalXMin = 0;
    globalYMin = 0;
    globalXMax = 500;
    globalYMax = 680;
    minLeftSideBearing = 0;
    minRightSideBearing = 0;
    xMaxExtent = 500;
  }

  const ascender = Math.max(850, globalYMax + 20);
  const descender = Math.min(-250, globalYMin - 20);

  // glyf + loca (long 32-bit offsets)
  const glyfTotalLen = glyphRecords.reduce((acc, g) => acc + g.encoded.bytes.length, 0);
  const glyfWriter = new BinaryWriter(Math.max(16, glyfTotalLen));
  const locaWriter = new BinaryWriter((glyphRecords.length + 1) * 4);
  for (const g of glyphRecords) {
    locaWriter.u32(glyfWriter.pos);
    if (g.encoded.bytes.length > 0) {
      glyfWriter.bytes(g.encoded.bytes);
    }
  }
  locaWriter.u32(glyfWriter.pos);
  const glyfTable = glyfWriter.toUint8Array();
  const locaTable = locaWriter.toUint8Array();

  // hmtx
  const hmtxWriter = new BinaryWriter(glyphRecords.length * 4);
  for (const g of glyphRecords) {
    hmtxWriter.u16(g.advanceWidth);
    hmtxWriter.i16(g.encoded.bytes.length > 0 ? g.encoded.xMin : 0);
  }
  const hmtxTable = hmtxWriter.toUint8Array();

  // cmap
  const codeMapEntries = [{ code: 32, glyphId: 1 }, { code: 160, glyphId: 1 }];
  for (let i = 2; i < glyphRecords.length; i++) {
    codeMapEntries.push({ code: glyphRecords[i].unicode, glyphId: i });
  }
  codeMapEntries.sort((a, b) => a.code - b.code);
  const cmapTable = buildCmapTable(codeMapEntries);

  const cleanFamily =
    sanitizeWinAnsi(familyName || 'MeineHandschrift')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim() || 'MeineHandschrift';
  const psBase = cleanFamily.replace(/[^a-zA-Z0-9-]/g, '') || 'MeineHandschrift';
  const postScriptName = `${psBase.slice(0, 50)}-Regular`;

  const firstChar = codeMapEntries[0].code;
  const lastChar = codeMapEntries[codeMapEntries.length - 1].code;
  const nowSec = Math.floor(Date.now() / 1000);

  // head (54 bytes)
  const headW = new BinaryWriter(54);
  headW.u16(1); // majorVersion
  headW.u16(0); // minorVersion
  headW.u32(0x00010000); // fontRevision 1.0
  headW.u32(0); // checkSumAdjustment (filled after assembling full font)
  headW.u32(0x5f0f3cf5); // magicNumber
  headW.u16(0x000b); // flags (baseline at y=0, lsb at x=0, integer ppem)
  headW.u16(unitsPerEm);
  headW.longDateTime(nowSec);
  headW.longDateTime(nowSec);
  headW.i16(globalXMin);
  headW.i16(globalYMin);
  headW.i16(globalXMax);
  headW.i16(globalYMax);
  headW.u16(0); // macStyle (Regular)
  headW.u16(8); // lowestRecPPEM
  headW.i16(2); // fontDirectionHint
  headW.i16(1); // indexToLocFormat (1 = 32-bit long offsets)
  headW.i16(0); // glyphDataFormat
  const headTable = headW.toUint8Array();

  // hhea (36 bytes)
  const hheaW = new BinaryWriter(36);
  hheaW.u16(1); // majorVersion
  hheaW.u16(0); // minorVersion
  hheaW.i16(ascender);
  hheaW.i16(descender);
  hheaW.i16(0); // lineGap
  hheaW.u16(advanceWidthMax);
  hheaW.i16(minLeftSideBearing);
  hheaW.i16(minRightSideBearing);
  hheaW.i16(xMaxExtent);
  hheaW.i16(1); // caretSlopeRise
  hheaW.i16(0); // caretSlopeRun
  hheaW.i16(0); // caretOffset
  hheaW.i16(0);
  hheaW.i16(0);
  hheaW.i16(0);
  hheaW.i16(0);
  hheaW.i16(0); // metricDataFormat
  hheaW.u16(glyphRecords.length); // numberOfHMetrics
  const hheaTable = hheaW.toUint8Array();

  // maxp v1.0 (32 bytes)
  const maxpW = new BinaryWriter(32);
  maxpW.u32(0x00010000); // version 1.0
  maxpW.u16(glyphRecords.length);
  maxpW.u16(maxPoints);
  maxpW.u16(maxContours);
  maxpW.u16(0); // maxCompositePoints
  maxpW.u16(0); // maxCompositeContours
  maxpW.u16(2); // maxZones
  maxpW.u16(0); // maxTwilightPoints
  maxpW.u16(0); // maxStorage
  maxpW.u16(0); // maxFunctionDefs
  maxpW.u16(0); // maxInstructionDefs
  maxpW.u16(0); // maxStackElements
  maxpW.u16(0); // maxSizeOfInstructions
  maxpW.u16(0); // maxComponentElements
  maxpW.u16(0); // maxComponentDepth
  const maxpTable = maxpW.toUint8Array();

  // OS/2 v4 (96 bytes)
  const winAscent = ascender;
  const winDescent = Math.max(0, -descender);
  const avgWidth = advWidthCount > 0 ? Math.round(advWidthSum / advWidthCount) : 500;
  const os2W = new BinaryWriter(96);
  os2W.u16(4); // version 4
  os2W.i16(avgWidth);
  os2W.u16(400); // usWeightClass (Regular)
  os2W.u16(5); // usWidthClass (Medium)
  os2W.u16(0); // fsType (Installable embedding)
  os2W.i16(650); // ySubscriptXSize
  os2W.i16(650); // ySubscriptYSize
  os2W.i16(0); // ySubscriptXOffset
  os2W.i16(140); // ySubscriptYOffset
  os2W.i16(650); // ySuperscriptXSize
  os2W.i16(650); // ySuperscriptYSize
  os2W.i16(0); // ySuperscriptXOffset
  os2W.i16(450); // ySuperscriptYOffset
  os2W.i16(50); // yStrikeoutSize
  os2W.i16(260); // yStrikeoutPosition
  os2W.i16(0x0a00); // sFamilyClass (Scripts)
  os2W.bytes(new Uint8Array([3, 0, 5, 2, 2, 0, 0, 2, 0, 4])); // panose (Script)
  os2W.u32(hasLatin1Supplement ? 0x00000003 : 0x00000001); // ulUnicodeRange1
  os2W.u32(0); // ulUnicodeRange2
  os2W.u32(0); // ulUnicodeRange3
  os2W.u32(0); // ulUnicodeRange4
  os2W.tag('SFKR'); // achVendID
  os2W.u16(0x00c0); // fsSelection (REGULAR | USE_TYPO_METRICS)
  os2W.u16(firstChar);
  os2W.u16(lastChar);
  os2W.i16(ascender); // sTypoAscender
  os2W.i16(descender); // sTypoDescender
  os2W.i16(0); // sTypoLineGap
  os2W.u16(winAscent); // usWinAscent
  os2W.u16(winDescent); // usWinDescent
  os2W.u32(0x00000001); // ulCodePageRange1 (Latin 1 / 1252)
  os2W.u32(0); // ulCodePageRange2
  os2W.i16(450); // sxHeight
  os2W.i16(700); // sCapHeight
  os2W.u16(0); // usDefaultChar
  os2W.u16(32); // usBreakChar
  os2W.u16(0); // usMaxContext
  const os2Table = os2W.toUint8Array();

  const nameTable = buildNameTable({ familyName: cleanFamily, postScriptName });
  const postTable = buildPostTable(glyphRecords);

  const tables = [
    { tag: 'OS/2', data: os2Table },
    { tag: 'cmap', data: cmapTable },
    { tag: 'glyf', data: glyfTable },
    { tag: 'head', data: headTable },
    { tag: 'hhea', data: hheaTable },
    { tag: 'hmtx', data: hmtxTable },
    { tag: 'loca', data: locaTable },
    { tag: 'maxp', data: maxpTable },
    { tag: 'name', data: nameTable },
    { tag: 'post', data: postTable },
  ].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  const numTables = tables.length;
  const maxPow2 = 1 << Math.floor(Math.log2(numTables));
  const searchRange = maxPow2 * 16;
  const entrySelector = Math.floor(Math.log2(numTables));
  const rangeShift = numTables * 16 - searchRange;

  const headerSize = 12 + numTables * 16;
  let offsetCursor = headerSize;
  const records = tables.map((t) => {
    const paddedLen = Math.ceil(t.data.length / 4) * 4;
    const rec = {
      tag: t.tag,
      data: t.data,
      checksum: calcTableChecksum(t.data),
      offset: offsetCursor,
      length: t.data.length,
    };
    offsetCursor += paddedLen;
    return rec;
  });

  const outW = new BinaryWriter(offsetCursor);
  outW.u32(0x00010000); // sfntVersion (TrueType)
  outW.u16(numTables);
  outW.u16(searchRange);
  outW.u16(entrySelector);
  outW.u16(rangeShift);

  let headOffset = 0;
  for (const r of records) {
    if (r.tag === 'head') headOffset = r.offset;
    outW.tag(r.tag);
    outW.u32(r.checksum);
    outW.u32(r.offset);
    outW.u32(r.length);
  }

  for (const r of records) {
    outW.bytes(r.data);
    outW.pad4();
  }

  const finalBytes = outW.toUint8Array();
  const wholeChecksum = calcTableChecksum(finalBytes);
  const checkSumAdjustment = (0xb1b0afba - wholeChecksum) >>> 0;
  const finalView = new DataView(finalBytes.buffer, finalBytes.byteOffset, finalBytes.byteLength);
  finalView.setUint32(headOffset + 8, checkSumAdjustment, false);

  return {
    arrayBuffer: finalBytes.buffer,
    glyphCount: glyphRecords.length - 2,
    familyName: cleanFamily,
    postScriptName,
  };
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function makeUuid() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().toUpperCase();
  }
  return 'XXXXXXXX-XXXX-4XXX-YXXX-XXXXXXXXXXXX'.replace(/[XY]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'X' ? r : (r & 0x3) | 0x8;
    return v.toString(16).toUpperCase();
  });
}

export function buildIosFontMobileConfig({
  familyName = 'MeineHandschrift',
  postScriptName,
  arrayBuffer,
}) {
  const safeName =
    sanitizeWinAnsi(familyName || 'MeineHandschrift')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim() || 'MeineHandschrift';
  const fileBase =
    (postScriptName || safeName.replace(/[^a-zA-Z0-9-]/g, '') || 'MeineHandschrift');
  const slug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom';
  const b64 = arrayBufferToBase64(arrayBuffer);
  const rootUuid = makeUuid();
  const payloadUuid = makeUuid();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadDisplayName</key>
  <string>${escapeXml(safeName)} (Handschrift)</string>
  <key>PayloadDescription</key>
  <string>Installiert deine eigene Handschrift als Systemschrift fuer Notability auf dem iPad.</string>
  <key>PayloadIdentifier</key>
  <string>app.schoolfucker.fontprofile.${escapeXml(slug)}</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${rootUuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>Name</key>
      <string>${escapeXml(fileBase)}.ttf</string>
      <key>Font</key>
      <data>${b64}</data>
      <key>PayloadIdentifier</key>
      <string>app.schoolfucker.fontpayload.${escapeXml(slug)}</string>
      <key>PayloadType</key>
      <string>com.apple.font</string>
      <key>PayloadUUID</key>
      <string>${payloadUuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
</dict>
</plist>
`;
}
