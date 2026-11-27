import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.use('/lib', express.static(path.join(__dirname, 'lib')));

app.get('/vendor/pdf-lib.esm.min.js', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/pdf-lib/dist/pdf-lib.esm.min.js'));
});

app.get('/vendor/pdf.min.mjs', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.min.mjs'));
});

app.get('/vendor/pdf.worker.min.mjs', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'));
});

app.get('/vendor/opentype.min.mjs', (_req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules/opentype.js/dist/opentype.min.mjs'));
});

app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
