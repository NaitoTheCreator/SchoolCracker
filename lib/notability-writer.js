import { PDFDocument, rgb } from 'pdf-lib';
import {
  PAGE_W,
  PAGE_H,
  hexToRgbUnit,
  getGlyphHorizontalMetrics,
  computeTextPages,
  layoutBoxText,
  transformGlyphStrokesToPagePoints,
} from './layout.js';
import { buildNotabilityPdf } from './pdf-builder.js';
import { getFallbackStrokeGlyph } from './stroke-font.js';

const APP_VERSION = '16.13';
const SESSION_FORMAT = 9;
// Notability PDF-template document geometry (Letter 612 x 792 pt -> 610 document units wide)
const TPL_W = 612;
const TPL_H = 792;
const DOC_PAGE_W = 610;
const K = DOC_PAGE_W / TPL_W;
const DOC_PAGE_H = TPL_H * K;

const enc = new TextEncoder();

// ── CRC32 + Pure-JS ZIP Archive Builder ──────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

export function createZipArchive(entries) {
  const { dosTime, dosDate } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [rawName, rawData] of entries) {
    const nameBytes = enc.encode(rawName);
    const data = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData || 0);
    const isDir = rawName.endsWith('/');
    const crc = crc32(data);

    // Local File Header (30 bytes + name)
    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed: 2.0
    ldv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    ldv.setUint16(8, 0, true); // compression: STORE
    ldv.setUint16(10, dosTime, true);
    ldv.setUint16(12, dosDate, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    localParts.push(lh, data);

    // Central Directory Header (46 bytes + name)
    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, dosTime, true);
    cdv.setUint16(14, dosDate, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, isDir ? 0x10 : 0, true);
    cdv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);

    centralParts.push(ch);
    offset += lh.length + data.length;
  }

  let centralSize = 0;
  for (const ch of centralParts) centralSize += ch.length;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  const totalSize = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const ch of centralParts) {
    out.set(ch, pos);
    pos += ch.length;
  }
  out.set(eocd, pos);
  return out;
}

// ── Binary Property List (bplist00) & NSKeyedArchiver / GLKeyedArchiver ──────

function setUint64(dv, offset, value) {
  const v = Number(value);
  const hi = Math.floor(v / 4294967296);
  const lo = v - hi * 4294967296;
  dv.setUint32(offset, hi >>> 0, false);
  dv.setUint32(offset + 4, lo >>> 0, false);
}

function setInt64(dv, offset, value) {
  let v = Math.trunc(value);
  if (v >= 0) {
    setUint64(dv, offset, v);
    return;
  }
  // Two's complement for negative 64-bit integer
  const abs = Math.abs(v);
  let hi = Math.floor(abs / 4294967296);
  let lo = abs - hi * 4294967296;
  lo = (~lo + 1) >>> 0;
  hi = (~hi + (lo === 0 ? 1 : 0)) >>> 0;
  dv.setUint32(offset, hi, false);
  dv.setUint32(offset + 4, lo, false);
}

const R = (v) => ({ real: v });
const U = (n) => ({ uid: n });

export function encodeBplist(root) {
  const objs = [];
  const parts = [];

  function add(v) {
    const idx = objs.length;
    objs.push(null);
    parts.push([idx, v]);
    return idx;
  }

  const top = add(root);
  const kids = new Map();

  for (let p = 0; p < parts.length; p++) {
    const [idx, v] = parts[p];
    if (Array.isArray(v)) {
      kids.set(idx, v.map(add));
    } else if (
      v &&
      typeof v === 'object' &&
      !(v instanceof Uint8Array) &&
      !('real' in v) &&
      !('uid' in v)
    ) {
      const ks = Object.keys(v);
      kids.set(idx, ks.map(add).concat(ks.map((k) => add(v[k]))));
    }
  }

  const refSize = objs.length < 256 ? 1 : objs.length < 65536 ? 2 : 4;
  const ref = (n) =>
    refSize === 1
      ? [n]
      : refSize === 2
        ? [(n >> 8) & 255, n & 255]
        : [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

  const intBytes = (n) => {
    if (n >= 0 && n < 256) return [0x10, n];
    if (n >= 0 && n < 65536) return [0x11, (n >> 8) & 255, n & 255];
    if (n >= 0 && n < 4294967296) {
      return [0x12, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const b = new Uint8Array(9);
    b[0] = 0x13;
    setInt64(new DataView(b.buffer), 1, n);
    return Array.from(b);
  };

  const head = (type, len) => (len < 15 ? [type | len] : [type | 15].concat(intBytes(len)));

  for (const [idx, v] of parts) {
    let b;
    if (v === null || v === undefined) {
      b = [0x00];
    } else if (v === false) {
      b = [0x08];
    } else if (v === true) {
      b = [0x09];
    } else if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        b = intBytes(v);
      } else {
        const x = new Uint8Array(9);
        x[0] = 0x23;
        new DataView(x.buffer).setFloat64(1, v, false);
        b = x;
      }
    } else if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) {
        b = head(0x50, v.length).concat(Array.from(v, (c) => c.charCodeAt(0)));
      } else {
        const utf16 = [];
        for (let k = 0; k < v.length; k++) {
          const code = v.charCodeAt(k);
          utf16.push((code >> 8) & 255, code & 255);
        }
        b = head(0x60, v.length).concat(utf16);
      }
    } else if (v instanceof Uint8Array) {
      const h = head(0x40, v.length);
      b = new Uint8Array(h.length + v.length);
      b.set(h);
      b.set(v, h.length);
    } else if ('real' in v) {
      const x = new Uint8Array(9);
      x[0] = 0x23;
      new DataView(x.buffer).setFloat64(1, v.real, false);
      b = x;
    } else if ('uid' in v) {
      const n = v.uid;
      b =
        n < 256
          ? [0x80, n]
          : n < 65536
            ? [0x81, (n >> 8) & 255, n & 255]
            : [0x83, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else if (Array.isArray(v)) {
      const arrRefs = [];
      for (const kid of kids.get(idx)) arrRefs.push(...ref(kid));
      b = head(0xa0, v.length).concat(arrRefs);
    } else {
      const ks = Object.keys(v);
      const dictRefs = [];
      for (const kid of kids.get(idx)) dictRefs.push(...ref(kid));
      b = head(0xd0, ks.length).concat(dictRefs);
    }
    objs[idx] = b instanceof Uint8Array ? b : new Uint8Array(b);
  }

  let size = 8;
  for (const o of objs) size += o.length;
  const offSize = size < 256 ? 1 : size < 65536 ? 2 : size < 16777216 ? 3 : 4;
  const out = new Uint8Array(size + objs.length * offSize + 32);
  out.set(enc.encode('bplist00'), 0);

  let o = 8;
  const offs = [];
  for (const objBytes of objs) {
    offs.push(o);
    out.set(objBytes, o);
    o += objBytes.length;
  }

  const tableAt = o;
  for (const off of offs) {
    for (let k = offSize - 1; k >= 0; k--) {
      out[o++] = (off >>> (8 * k)) & 255;
    }
  }

  const dv = new DataView(out.buffer);
  out[o + 6] = offSize;
  out[o + 7] = refSize;
  setUint64(dv, o + 8, objs.length);
  setUint64(dv, o + 16, top);
  setUint64(dv, o + 24, tableAt);
  return out;
}

function createArchiver() {
  const objects = ['$null'];
  const classes = new Map();

  const put = (obj) => {
    objects.push(obj);
    return U(objects.length - 1);
  };

  const cls = (name, chain, hints) => {
    if (!classes.has(name)) {
      const c = { $classname: name };
      if (chain) c.$classes = chain;
      if (hints) c.$classhints = hints;
      classes.set(name, put(c));
    }
    return classes.get(name);
  };

  return {
    objects,
    put,
    cls,
    obj(name, chain, fields) {
      return put(Object.assign({ $class: cls(name, chain) }, fields));
    },
    arr(items, mutable = false) {
      return put({
        'NS.objects': items,
        $class: mutable
          ? cls('NSMutableArray', ['NSMutableArray', 'NSArray', 'NSObject'])
          : cls('NSArray', ['NSArray', 'NSObject']),
      });
    },
    dict(map) {
      const keys = Object.keys(map);
      // Every NSMutableDictionary value MUST be a UID reference (never inline primitives) for iOS Notability
      return put({
        'NS.keys': keys.map((k) => put(k)),
        'NS.objects': keys.map((k) => (map[k] && map[k].uid !== undefined ? map[k] : put(map[k]))),
        $class: cls('NSMutableDictionary', ['NSMutableDictionary', 'NSDictionary', 'NSObject']),
      });
    },
    mstring(s) {
      return put({
        $class: cls('NSMutableString', ['NSMutableString', 'NSString', 'NSObject']),
        'NS.bytes': enc.encode(s),
      });
    },
    date(t) {
      return put({
        $class: cls('NSDate', ['NSDate', 'NSObject']),
        'NS.time': R(t),
      });
    },
    uuid(b) {
      return put({
        'NS.uuidbytes': b,
        $class: cls('NSUUID', ['NSUUID', 'NSObject']),
      });
    },
    color(white, alpha, sysName) {
      return put(
        Object.assign(sysName ? { UISystemColorName: put(sysName) } : {}, {
          UIColorComponentCount: 2,
          UIWhite: R(white),
          UIAlpha: R(alpha),
          NSWhite: enc.encode(alpha === 1 ? String(white) : `${white} ${alpha}`),
          NSColorSpace: 4,
          $class: cls('UIColor', ['UIColor', 'NSObject'], ['NSColor']),
        })
      );
    },
    rgb(r, g, b) {
      return put({
        UIColorComponentCount: 4,
        UIRed: R(r),
        UIGreen: R(g),
        UIBlue: R(b),
        UIAlpha: R(1),
        NSRGB: enc.encode(`${r} ${g} ${b}`),
        NSColorSpace: 2,
        $class: cls('UIColor', ['UIColor', 'NSObject'], ['NSColor']),
      });
    },
    bytes(root, archiverName = 'NSKeyedArchiver') {
      return encodeBplist({
        $version: 100000,
        $archiver: archiverName,
        $top: root,
        $objects: objects,
      });
    },
  };
}

// ── Helpers for Geometry, UUIDs & Images ─────────────────────────────────────

function uuidBytes() {
  const b = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

function uuidStr(b) {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const fmtNum = (v) => {
  const r = Math.round(v * 1e6) / 1e6;
  return String(Object.is(r, -0) ? 0 : r);
};
const fmtPt = (x, y) => `{${fmtNum(x)}, ${fmtNum(y)}}`;
const fmtRect = (x, y, w, h) => `{{${fmtNum(x)}, ${fmtNum(y)}}, {${fmtNum(w)}, ${fmtNum(h)}}}`;
const appleTime = () => Date.now() / 1000 - 978307200;

function dataUrlToUint8Array(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return new Uint8Array(0);
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

function imageSizeFromBytes(b) {
  if (!b || b.length < 24) return { w: PAGE_W, h: PAGE_H, jpeg: true };
  if (b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    return { w: dv.getUint32(16, false), h: dv.getUint32(20, false), jpeg: false };
  }
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const mk = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return {
        h: (b[i + 5] << 8) | b[i + 6],
        w: (b[i + 7] << 8) | b[i + 8],
        jpeg: true,
      };
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return { w: PAGE_W, h: PAGE_H, jpeg: true };
}

async function ensureJpegBytes(bytes) {
  const info = imageSizeFromBytes(bytes);
  if (info.jpeg) return { bytes, w: info.w, h: info.h };

  if (typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
      c.width = c.height = 0;
      if (blob) {
        return { bytes: new Uint8Array(await blob.arrayBuffer()), w: info.w, h: info.h };
      }
    } catch {
      // Fall through cleanly if canvas conversion fails
    }
  }
  return { bytes, w: info.w, h: info.h };
}

function float32LeBytes(arr) {
  const out = new Uint8Array(arr.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < arr.length; i++) dv.setFloat32(i * 4, arr[i], true);
  return out;
}

function int32LeBytes(arr) {
  const out = new Uint8Array(arr.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < arr.length; i++) dv.setInt32(i * 4, arr[i], true);
  return out;
}

/** Convert polyline [{x, y}, ...] in page px to Notability cubic Bézier points array */
function polylineToNotabilityBezier(ptsPx, tx, smooth = true) {
  if (!Array.isArray(ptsPx) || ptsPx.length === 0) return null;
  if (ptsPx.length === 1) {
    const [x, y] = tx(ptsPx[0].x, ptsPx[0].y);
    return [x, y, x + 0.01, y, x + 0.02, y, x + 0.03, y];
  }

  const cmds = [['M', ...tx(ptsPx[0].x, ptsPx[0].y)]];
  if (!smooth || ptsPx.length === 2) {
    for (let i = 1; i < ptsPx.length; i++) {
      cmds.push(['L', ...tx(ptsPx[i].x, ptsPx[i].y)]);
    }
  } else {
    for (let i = 1; i < ptsPx.length; i++) {
      const p = tx(ptsPx[i].x, ptsPx[i].y);
      if (i === ptsPx.length - 1) {
        cmds.push(['L', p[0], p[1]]);
      } else {
        const next = tx(ptsPx[i + 1].x, ptsPx[i + 1].y);
        cmds.push(['Q', p[0], p[1], (p[0] + next[0]) / 2, (p[1] + next[1]) / 2]);
      }
    }
  }

  const out = [];
  let px = 0;
  let py = 0;
  let started = false;

  for (const c of cmds) {
    if (c[0] === 'M' && !started) {
      px = c[1];
      py = c[2];
      out.push(px, py);
      started = true;
      continue;
    }
    if (!started) continue;
    if (c[0] === 'L' || c[0] === 'M') {
      const ex = c[1];
      const ey = c[2];
      out.push(
        px + (ex - px) / 3,
        py + (ey - py) / 3,
        px + (2 * (ex - px)) / 3,
        py + (2 * (ey - py)) / 3,
        ex,
        ey
      );
      px = ex;
      py = ey;
    } else if (c[0] === 'Q') {
      const qx = c[1];
      const qy = c[2];
      const ex = c[3];
      const ey = c[4];
      out.push(
        px + (2 / 3) * (qx - px),
        py + (2 / 3) * (qy - py),
        ex + (2 / 3) * (qx - ex),
        ey + (2 / 3) * (qy - ey),
        ex,
        ey
      );
      px = ex;
      py = ey;
    }
  }

  if (!started) return null;
  if (out.length === 2) out.push(px + 0.01, py, px + 0.02, py, px + 0.03, py);
  return out;
}

const BLACK_STR = '0.000000000000000,0.000000000000000,0.000000000000000,1.000000000000000';
const CLEAR_STR = '0.000000000000000,0.000000000000000,0.000000000000000,0.000000000000000';

// ── Main Notability .note Builder ────────────────────────────────────────────

export async function buildNotabilityNote({
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
  measureCharWidth = null,
  renderThumbnailPng = null,
  renderSheetBgDataUrl = null,
}) {
  const safeName =
    String(title || 'Mein Heft')
      .replace(/[\/\\:]/g, '-')
      .trim() || 'Mein Heft';

  const measureStrokeOrFallbackWidth = (ch, fontName, fs) => {
    const strokeGlyph = getFallbackStrokeGlyph(ch);
    if (strokeGlyph && strokeGlyph.length > 0) {
      const { span } = getGlyphHorizontalMetrics(strokeGlyph);
      return Math.max(fs * 0.16, span * (fs / 145) + fs * 0.08);
    }
    if (typeof measureCharWidth === 'function') {
      return measureCharWidth(ch, fontName, fs);
    }
    return null;
  };

  // 1. Compute layout for all pages
  const flowPages = computeTextPages({
    text,
    font,
    fontSize,
    lineHeight,
    letterSpacing,
    margin,
    seedOffset,
    glyphs,
    measureCharWidth: measureStrokeOrFallbackWidth,
  });
  const totalPages = Math.max(flowPages.length, sheets.length, 1);

  // 2. Build clean background-only PDF for TemplatePDF (page 0 establishes the template;
  //    additional pages with different backgrounds also get locked JPEG ImageMediaObjects so multi-page PDFs show every page!)
  const bgOnlyPdfBytes = await buildNotabilityPdf({
    text: '',
    font,
    paper,
    title: safeName,
    inkColor,
    fontSize,
    lineHeight,
    letterSpacing,
    margin,
    seedOffset,
    glyphs,
    customBgDataUrl,
    basePdfBytes,
    sheets: sheets.length > 0 ? sheets : [{ id: 's0', paperOverride: 'inherit' }],
    exportMode: 'template-only',
  });

  const bgPdfDoc = await PDFDocument.load(bgOnlyPdfBytes);
  const firstPdfPage = bgPdfDoc.getPage(0);
  const firstPdfW = firstPdfPage.getWidth();
  const firstPdfH = firstPdfPage.getHeight();
  const firstTs = Math.min(TPL_W / firstPdfW, TPL_H / firstPdfH);
  const firstTox = (TPL_W - firstPdfW * firstTs) / 2;

  const tplDoc = await PDFDocument.create();
  const tplPage = tplDoc.addPage([TPL_W, TPL_H]);
  tplPage.drawRectangle({ x: 0, y: 0, width: TPL_W, height: TPL_H, color: rgb(1, 1, 1) });
  const [embTpl] = await tplDoc.embedPdf(bgOnlyPdfBytes, [0]);
  tplPage.drawPage(embTpl, {
    x: firstTox,
    y: TPL_H - firstPdfH * firstTs,
    width: firstPdfW * firstTs,
    height: firstPdfH * firstTs,
  });
  const tplPdfBytes = new Uint8Array(await tplDoc.save());
  const tplName = `${uuidStr(uuidBytes())}.pdf`;

  // Coordinate transform per page: SchoolFucker px (PAGE_W x PAGE_H) -> Notability document units
  const ts = Math.min(TPL_W / PAGE_W, TPL_H / PAGE_H);
  const tox = (TPL_W - PAGE_W * ts) / 2;
  const s = ts * K;
  const ox = tox * K;

  const docStrokes = []; // { p: number[], width: number, rgba: [r, g, b, a], hl: boolean }
  const docImages = []; // { name, bytes, pw, ph, x, y, w, h, locked }
  let imgCounter = 0;

  const sheet0 = sheets[0] || {};
  const sheet0Paper =
    sheet0.paperOverride && sheet0.paperOverride !== 'inherit' ? sheet0.paperOverride : paper;

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const oy = pageIdx * DOC_PAGE_H;
    const tx = (px, py) => [ox + px * s, oy + py * s];

    const sheet = sheets[pageIdx] || {};
    const effectivePaper =
      sheet.paperOverride && sheet.paperOverride !== 'inherit' ? sheet.paperOverride : paper;

    // For page 2+, if the page has a distinct worksheet/background from page 0, attach it as a locked JPEG background
    if (pageIdx > 0) {
      const isDistinctImportedPdf =
        effectivePaper === 'imported-pdf' &&
        (sheet.importedPageIndex ?? pageIdx) !== (sheet0.importedPageIndex ?? 0);
      const isDistinctCustomImg =
        effectivePaper === 'custom-png' &&
        (sheet.customBgDataUrl || customBgDataUrl) !== (sheet0.customBgDataUrl || customBgDataUrl);
      const isDistinctPaperStyle = effectivePaper !== sheet0Paper;

      if (isDistinctImportedPdf || isDistinctCustomImg || isDistinctPaperStyle) {
        let bgDataUrl = null;
        if (effectivePaper === 'imported-pdf' && sheet.importedPreviewDataUrl) {
          bgDataUrl = sheet.importedPreviewDataUrl;
        } else if (effectivePaper === 'custom-png' && (sheet.customBgDataUrl || customBgDataUrl)) {
          bgDataUrl = sheet.customBgDataUrl || customBgDataUrl;
        } else if (typeof renderSheetBgDataUrl === 'function') {
          bgDataUrl = renderSheetBgDataUrl(sheet, pageIdx);
        }

        if (bgDataUrl) {
          const rawBytes = dataUrlToUint8Array(bgDataUrl);
          if (rawBytes.length > 0) {
            const jpg = await ensureJpegBytes(rawBytes);
            docImages.push({
              name: `Image ${++imgCounter}.jpg`,
              bytes: jpg.bytes,
              pw: jpg.w,
              ph: jpg.h,
              x: ox,
              y: oy,
              w: PAGE_W * s,
              h: PAGE_H * s,
              locked: true,
            });
          }
        }
      }
    }

    const pushGlyphItemsAsStrokes = (items, itemFontSize, itemInkHex) => {
      const unitRgb = hexToRgbUnit(itemInkHex || inkColor);
      const rgba = [unitRgb.r, unitRgb.g, unitRgb.b, 1];
      const strokeWidth = Math.max(0.45, Math.max(1.5, itemFontSize * 0.062) * s);

      for (const item of items) {
        const customStrokes =
          font === 'my-script' && item.variantIdx >= 0 ? glyphs[item.ch]?.[item.variantIdx] : null;
        const rawStrokes =
          customStrokes && customStrokes.length > 0 ? customStrokes : getFallbackStrokeGlyph(item.ch);
        if (!rawStrokes || rawStrokes.length === 0) continue;

        const polylinesPx = transformGlyphStrokesToPagePoints({
          strokes: rawStrokes,
          itemX: item.x,
          itemY: item.y,
          rot: item.rot,
          size: itemFontSize,
          minX: customStrokes && customStrokes.length > 0 ? item.minX : null,
        });

        for (const poly of polylinesPx) {
          const p = polylineToNotabilityBezier(poly, tx, true);
          if (p) {
            docStrokes.push({ p, width: strokeWidth, rgba, hl: false });
          }
        }
      }
    };

    // Whiteout / Tipp-Ex strokes go right above paper and beneath handwriting
    const whiteouts = Array.isArray(sheet.whiteoutStrokes) ? sheet.whiteoutStrokes : [];
    for (const wStroke of whiteouts) {
      if (!wStroke || !Array.isArray(wStroke.points) || wStroke.points.length === 0) continue;
      const p = polylineToNotabilityBezier(wStroke.points, tx, true);
      if (p) {
        docStrokes.push({
          p,
          width: Math.max(2, (wStroke.width || 18) * s),
          rgba: [1, 1, 1, 1],
          hl: false,
        });
      }
    }

    // Flow text strokes
    const flowPage = flowPages[pageIdx];
    if (flowPage?.items?.length) {
      pushGlyphItemsAsStrokes(flowPage.items, fontSize, inkColor);
    }

    // Placed TextBoxes strokes
    const textBoxes = Array.isArray(sheet.textBoxes) ? sheet.textBoxes : [];
    for (let bIdx = 0; bIdx < textBoxes.length; bIdx++) {
      const box = textBoxes[bIdx];
      if (!box || !box.text) continue;
      const boxFs = box.fontSize || fontSize;
      const boxLh = Math.round(boxFs * 1.32);
      const layout = layoutBoxText({
        text: box.text,
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
        measureCharWidth: measureStrokeOrFallbackWidth,
      });
      pushGlyphItemsAsStrokes(layout.items, boxFs, box.inkColor || inkColor);
    }

    // Freehand pen strokes
    const freehandStrokes = Array.isArray(sheet.strokes) ? sheet.strokes : [];
    for (const st of freehandStrokes) {
      if (!st || !Array.isArray(st.points) || st.points.length === 0) continue;
      const c = hexToRgbUnit(st.color || inkColor);
      const p = polylineToNotabilityBezier(st.points, tx, true);
      if (p) {
        docStrokes.push({
          p,
          width: Math.max(0.45, (st.width || 3) * s),
          rgba: [c.r, c.g, c.b, 1],
          hl: false,
        });
      }
    }
  }

  // 3. Build Session.plist (GLKeyedArchiver)
  const A = createArchiver();
  const root = A.put(null);
  const fontName = docImages.length ? A.put('HelveticaNeue') : null;

  const media = docImages.map((im, z) => {
    const fig = A.obj('Figure', ['Figure', 'NSObject'], {
      kFigurePrimitiveObjectsArrayKey: A.arr([], true),
      FigureObjectTypeKey: 1,
      FigureCanvasSizeKey: A.put('{0, 0}'),
      FigureCropRectKey: A.put(fmtRect(0, 0, im.pw, im.ph)),
      $0: U(0),
      FigureBackgroundObjectKey: A.obj('ImageObject', ['ImageObject', 'DrawObject', 'NSObject'], {
        kImageObjectSnapshotKey: A.obj('GLSnapshot', ['GLSnapshot', 'NSObject'], {
          saveAsJPEG: true,
          imageIsMissing: false,
          relativePath: A.put('Images/' + im.name),
        }),
        fillColorCrossPlatform: A.put(CLEAR_STR),
        fillColor: A.color(0, 0),
        strokeAlpha: R(1),
        strokeWidth: R(1),
        strokeColor: A.color(0, 1),
        fillAlpha: R(1),
        strokeColorCrossPlatform: A.put(BLACK_STR),
        rect: A.put('{{0, 0}, {0, 0}}'),
      }),
    });
    const origin = fmtPt(im.x, im.y);
    return A.obj('ImageMediaObject', ['ImageMediaObject', 'GenericMediaObject', 'NSObject'], {
      isFlippedHorizontal: false,
      unscaledContentSize: A.put(fmtPt(im.w, im.h)),
      locked: !!im.locked,
      captionFontColorCrossPlatform: A.put(BLACK_STR),
      documentOrigin: A.put(origin),
      isCaptionEnabled: false,
      rotationDegrees: R(0),
      captionIsUnderlined: false,
      documentContentOrigin: A.put(origin),
      isFlippedVertical: false,
      captionFieldText: U(0),
      minDimension: R(8),
      figure: fig,
      textWrapMode: 1,
      cornerMode: 1,
      UUID: A.uuid(uuidBytes()),
      indexable: false,
      captionFontName: fontName,
      assetsIdKey: A.mstring(uuidStr(uuidBytes())),
      handwritingZIndecesKey: A.arr([], true),
      captionFontSize: R(12),
      zIndex: z,
      captionFontColor: A.color(0, 1, 'blackColor'),
      maxDimension: R(Math.max(1024, Math.ceil(Math.max(im.w, im.h)))),
    });
  });

  // Sort highlighters before pen strokes if any highlighters exist
  docStrokes.sort((a, b) => (b.hl ? 1 : 0) - (a.hl ? 1 : 0));

  let nPts = 0;
  let nNodes = 0;
  for (const st of docStrokes) {
    nPts += st.p.length / 2;
    nNodes += (st.p.length / 2 - 1) / 3 + 1;
  }

  const nc = docStrokes.length;
  const fpts = new Float32Array(nPts * 2);
  const npts = new Int32Array(nc);
  const widths = new Float32Array(nc);
  const colors = new Uint8Array(nc * 4);
  const styles = new Uint8Array(nc);
  const uuids = new Uint8Array(nc * 16);
  const ones = new Float32Array(nNodes).fill(1);
  const alt = new Float32Array(nNodes).fill(Math.PI / 2);
  const az = new Float32Array(nNodes * 2);
  for (let i = 0; i < nNodes; i++) az[2 * i] = 1;

  let ptOffset = 0;
  docStrokes.forEach((st, i) => {
    fpts.set(st.p, ptOffset);
    ptOffset += st.p.length;
    npts[i] = st.p.length / 2;
    widths[i] = st.width;
    const alpha = st.rgba[3] === undefined ? 1 : st.rgba[3];
    for (let k = 0; k < 3; k++) {
      colors[4 * i + k] = Math.max(0, Math.min(255, Math.round(st.rgba[k] * 255)));
    }
    colors[4 * i + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    styles[i] = st.hl ? 4 : 3;
    uuids.set(uuidBytes(), 16 * i);
  });

  // InkedSpatialHash has NO $classes array in Notability 16.13
  const hash = A.obj('InkedSpatialHash', null, {
    numpoints: A.put(nPts),
    options: new Uint8Array(nc * 8),
    numfractionalwidths: A.put(nNodes),
    groupsArrays: A.arr([], true),
    curvesaltitudeangles: float32LeBytes(alt),
    curvespoints: float32LeBytes(fpts),
    curveUUIDs: uuids,
    curvescolors: colors,
    curvesfractionalwidths: float32LeBytes(ones),
    curvesnumpoints: int32LeBytes(npts),
    curvesforces: float32LeBytes(ones),
    curvesazimuthunitvector: float32LeBytes(az),
    curveswidth: float32LeBytes(widths),
    curvesstyles: styles,
    bezierPathsDataDictionary: A.dict({}),
    numcurves: A.put(nc),
  });

  const NL = '\n'.repeat(22);
  const subRange = (withColor) => {
    if (!withColor) {
      return A.dict({
        subRangeOtherAttributesKey: A.dict({}),
        subRangeRangeKey: A.put('{0, 22}'),
      });
    }
    return A.dict({
      subRangeColorCrossPlatformKey: A.put(BLACK_STR),
      subRangeRangeKey: A.put('{0, 22}'),
      subRangeFontKey: A.dict({
        NSFontSizeAttribute: R(12),
        NSFontNameAttribute: A.put('HelveticaNeue'),
      }),
      subRangeOtherAttributesKey: A.dict({
        NSStrikethrough: 0,
        NSUnderline: 0,
        'line-spacing': R(1),
        NSBaselineOffset: R(0),
      }),
      subRangeColorKey: A.rgb(0, 0, 0),
    });
  };

  const richText = A.obj('FormattedString', ['FormattedString', 'NSObject'], {
    formatVersion: 5,
    formattedStringTextAlignmentKey: 0,
    attributedString: A.dict({
      stringKey: A.put(NL),
      subRangesKey: A.arr([subRange(true)], true),
    }),
    NBAttributedBackingString: A.obj('NBAttributedString', ['NBAttributedString', 'NSObject'], {
      NBAttributedBackingStringCodingKey: A.dict({
        stringKey: A.mstring(NL),
        subRangesKey: A.arr([subRange(true)], true),
      }),
      NBAttributedLayoutStringCodingKey: A.dict({
        stringKey: A.mstring(NL),
        subRangesKey: A.arr([subRange(true)], true),
      }),
    }),
    'Handwriting Overlay': A.obj('HandwritingObject', ['HandwritingObject', 'NSObject'], {
      SpatialHash: hash,
    }),
    reflowState: A.obj('NBReflowStateLocked', ['NBReflowStateLocked', 'NBReflowState', 'NSObject'], {
      pageWidthInDocumentCoordsKey: R(DOC_PAGE_W),
      nativeLayoutDeviceStringKey: A.put('Letter'),
    }),
    didBecomeReflowable: true,
    pdfFiles: A.arr([
      A.obj('PDFFile', ['PDFFile', 'NSObject'], {
        pdfFileName: A.put(tplName),
        contentBoxVersion: A.put(1),
        highlights: A.arr([]),
        type: A.put(1),
        version: A.put(2),
      }),
    ]),
    mediaObjects: A.arr(media),
    recordingTimestampString: A.dict({
      stringKey: A.mstring(NL),
      subRangesKey: A.arr([subRange(false)], true),
    }),
    pageLayoutArray: A.arr([], true),
  });

  const now = appleTime();
  const pkg = A.put(safeName);
  const sessionFields = {
    subject: A.put('unsortedNotesKey'),
    NBNoteTakingSessionBundleVersionNumberKey: A.put(APP_VERSION),
    NBNoteTakingSessionHandwritingLanguageKey: A.put('de_DE'),
    contentPlaybackEventManager: A.obj('NBCPEventManager', ['NBCPEventManager', 'NSObject'], {
      NBCPTimeManagerSOAEventUUIDsKey: new Uint8Array(0),
      NBCPTimeManagerSOATimestampsKey: new Uint8Array(0),
      NBCPTimeManagerSOANumEventsKey: 0,
      NBCPTimeManagerSOARecordingIDsKey: new Uint8Array(0),
      NBCPTimeManagerSOADurationsKey: new Uint8Array(0),
    }),
    NBPaperMinorVersionNumber: 0,
    NBNoteTakingSessionLastUsedFontKey: U(0),
    NBNoteTakingSessionMinorVersionNumberKey: 0,
    packagePath: pkg,
    tags: A.put(''),
    NBNoteTakingSessionIsHighlighterBehindTextKey: true,
    sessionFormatVersion: SESSION_FORMAT,
    NBNoteTakingSessionDocumentPaperLayoutModelKey: A.obj(
      'Notability.NoteDocumentPaperLayoutModel',
      ['NoteDocumentPaperLayoutModel', 'NSObject'],
      {
        documentPaperAttributes: A.obj('GLModel.PaperAttributes', ['GLModel.PaperAttributes', 'NSObject'], {
          paperIdentifier: A.put('TemplatePDF:' + tplName.slice(0, -4) + ':#FFFFFF'),
          drawRotatedForOrientation: true,
          paperOrientation: A.put('portrait'),
          paperSize: A.put('letter'),
          paperSizingBehavior: A.put('staticWidth'),
          alignsTextToLines: true,
          lineStyle2: A.put('No Lines'),
        }),
        pageLayoutArray: A.arr([], true),
      }
    ),
    NBNoteTakingSessionAllowHighlighterConversionKey: false,
    NBPaperMajorVersionNumber: 3,
    richText,
    isReadOnly: false,
    creationDate: A.date(now),
    name: pkg,
  };

  A.objects[root.uid] = Object.assign(
    { $class: A.cls('NoteTakingSession', ['NoteTakingSession', 'NSObject']) },
    sessionFields
  );
  const sessionBytes = A.bytes({ $0: root }, 'GLKeyedArchiver');

  // 4. Build metadata.plist (NSKeyedArchiver)
  const M = createArchiver();
  const mroot = M.put(null);
  const dateUid = (d) => M.date(d);
  const changeDict = M.put({
    'NS.keys': [4, 2, 16, 8, 1].map((k) => M.put(k)),
    'NS.objects': [dateUid(now), dateUid(now), dateUid(now), dateUid(now), dateUid(now)],
    $class: M.cls('NSMutableDictionary', ['NSMutableDictionary', 'NSDictionary', 'NSObject']),
  });
  const noteNameUid = M.put(safeName);
  const emptyArr = M.arr([]);
  M.objects[mroot.uid] = {
    $class: M.cls('SessionInfo', ['SessionInfo', 'NSObject']),
    associatedProductsKey: emptyArr,
    galleryPublishHistoryKey: emptyArr,
    noteCreationDateKey: dateUid(now),
    noteHasRecordingKey: false,
    noteLastChangeDatePerTypeKey: changeDict,
    noteModifiedDateKey: dateUid(now),
    noteName: noteNameUid,
    notePackagePath: noteNameUid,
    noteSubject: M.put('unsortedNotesKey'),
    noteTags: M.put(''),
    uuidKey: M.put(uuidStr(uuidBytes())),
  };
  const metadataBytes = M.bytes({ root: mroot }, 'NSKeyedArchiver');

  // 5. Recordings/library.plist
  const libraryBytes = enc.encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0">\n' +
      '<dict>\n' +
      '\t<key>application version</key>\n' +
      '\t<string>7176</string>\n' +
      '\t<key>library-format-version</key>\n' +
      '\t<string>1.0</string>\n' +
      '\t<key>recordings</key>\n' +
      '\t<dict/>\n' +
      '</dict>\n' +
      '</plist>\n'
  );

  // 6. Optional thumbnail
  let thumbBytes = null;
  if (typeof renderThumbnailPng === 'function') {
    try {
      thumbBytes = await renderThumbnailPng(576, Math.round(576 * (DOC_PAGE_H / DOC_PAGE_W)));
    } catch {
      thumbBytes = null;
    }
  }

  const dir = safeName + '/';
  const entries = [
    [dir, new Uint8Array(0)],
    [dir + 'Session.plist', sessionBytes],
    [dir + 'metadata.plist', metadataBytes],
  ];
  if (thumbBytes && thumbBytes.length > 0) {
    entries.push([dir + 'thumb12x.png', thumbBytes]);
  }
  entries.push([dir + 'Assets/', new Uint8Array(0)], [dir + 'Images/', new Uint8Array(0)]);
  for (const im of docImages) {
    entries.push([dir + 'Images/' + im.name, im.bytes]);
  }
  entries.push(
    [dir + 'NBPDFIndex/', new Uint8Array(0)],
    [dir + 'PDFs/', new Uint8Array(0)],
    [dir + 'PDFs/' + tplName, tplPdfBytes],
    [dir + 'HandwritingIndex/', new Uint8Array(0)],
    [dir + 'Recordings/', new Uint8Array(0)],
    [dir + 'Recordings/library.plist', libraryBytes]
  );

  const noteBytes = createZipArchive(entries);
  return {
    noteBytes,
    safeName,
    strokeCount: nc,
    pageCount: totalPages,
    imageCount: docImages.length,
    templatePdfName: tplName,
  };
}
