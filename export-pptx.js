#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, 'template.html');
const NOTES_FILE = path.join(ROOT, 'speaker-notes.json');
const OUT_FILE = path.join(ROOT, 'presentation_exported_script.pptx');
const EXPORT_W = Number(process.env.EXPORT_W || 1280);
const EXPORT_H = Number(process.env.EXPORT_H || 720);
const DEVICE_SCALE = Number(process.env.EXPORT_SCALE || 3);
const PORT = Number(process.env.EXPORT_PORT || 3187);
const CHROME_DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9223);
const TOKEN = process.env.CONTROL_TOKEN || 'export-token';
const PPT_W = 13.333333;
const PPT_H = 7.5;

function countSlides() {
  const html = fs.readFileSync(HTML_FILE, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const matches = html.match(/<section\s+class="[^"]*\bslide\b/g);
  return matches ? matches.length : 0;
}

function waitForServer(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      const req = http.get(`http://127.0.0.1:${port}/`, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server did not start in time'));
        else setTimeout(ping, 150);
      });
      req.setTimeout(1000, () => {
        req.destroy();
      });
    }
    ping();
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(address.port));
    });
    srv.on('error', reject);
  });
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome/Chromium was not found. Set CHROME_BIN to the browser executable path.');
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

function waitForChrome(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      fetchJson(`http://127.0.0.1:${port}/json/version`, 1000).then(resolve).catch(() => {
        if (Date.now() - start > timeoutMs) reject(new Error('Chrome DevTools did not start in time'));
        else setTimeout(ping, 150);
      });
    }
    ping();
  });
}

function startChrome(chrome, port) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-ppt-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${EXPORT_W},${EXPORT_H}`,
    `--force-device-scale-factor=${DEVICE_SCALE}`,
    'about:blank'
  ];
  const proc = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.profileDir = profileDir;
  return proc;
}

function createCdpClient(wsUrl) {
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
      return;
    }
    const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
    const list = listeners.get(key);
    if (list) list.slice().forEach(fn => fn(msg));
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      pending.set(msg.id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });
  }

  function once(method, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    return new Promise(resolve => {
      const handler = msg => {
        const list = listeners.get(key) || [];
        listeners.set(key, list.filter(fn => fn !== handler));
        resolve(msg);
      };
      const list = listeners.get(key) || [];
      list.push(handler);
      listeners.set(key, list);
    });
  }

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({ send, once, close: () => ws.close() }));
    ws.addEventListener('error', () => reject(new Error('Failed to connect to Chrome DevTools')));
  });
}

async function createPageSession(cdp) {
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: EXPORT_W,
    height: EXPORT_H,
    deviceScaleFactor: DEVICE_SCALE,
    mobile: false
  }, sessionId);
  return sessionId;
}

async function captureSlide(cdp, sessionId, url, outPath) {
  const loaded = cdp.once('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;
  await cdp.send('Runtime.evaluate', {
    expression: 'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true',
    awaitPromise: true
  }, sessionId);
  await cdp.send('Runtime.evaluate', {
    expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    awaitPromise: true
  }, sessionId);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  }, sessionId);
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { dosTime, dosDate } = dosDateTime(now);

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, data);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    central.push(centralHeader);

    offset += local.length + data.length;
  }

  const centralStart = offset;
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readSpeakerNotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('speaker-notes.json must contain an object keyed by slide number');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Failed to read speaker-notes.json: ${err.message}`);
  }
}

function contentTypes(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const images = Array.from({ length: slideCount }, (_, i) => `<Override PartName="/ppt/media/image${i + 1}.png" ContentType="image/png"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${images}
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
${slides}
</Types>`;
}

function presentationXml(slideCount) {
  const ids = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldSz cx="12192000" cy="6858000" type="wide"/>
<p:notesSz cx="6858000" cy="9144000"/>
<p:sldIdLst>${ids}</p:sldIdLst>
</p:presentation>`;
}

function presentationRels(slideCount) {
  const rels = [
    ...Array.from({ length: slideCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`),
    `<Relationship Id="rId${slideCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties" Target="../docProps/core.xml"/>`,
    `<Relationship Id="rId${slideCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="../docProps/app.xml"/>`
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function slideXml(index) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide ${index}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function slideRels(index) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${index}.png"/>
</Relationships>`;
}

function buildPptx(imageFiles, outFile) {
  const slideCount = imageFiles.length;
  const now = new Date().toISOString();
  const entries = [
    { name: '[Content_Types].xml', data: contentTypes(slideCount) },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape('HTML PPT Export')}</dc:title><dc:creator>export-pptx.js</dc:creator><cp:lastModifiedBy>export-pptx.js</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>export-pptx.js</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slideCount}</Slides></Properties>` },
    { name: 'ppt/presentation.xml', data: presentationXml(slideCount) },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels(slideCount) }
  ];

  imageFiles.forEach((file, i) => {
    const index = i + 1;
    entries.push({ name: `ppt/slides/slide${index}.xml`, data: slideXml(index) });
    entries.push({ name: `ppt/slides/_rels/slide${index}.xml.rels`, data: slideRels(index) });
    entries.push({ name: `ppt/media/image${index}.png`, data: fs.readFileSync(file) });
  });

  fs.writeFileSync(outFile, createZip(entries));
}

async function buildPptxWithBrowserPptxGen(cdp, sessionId, imageFiles, outFile, speakerNotes = {}) {
  await cdp.send('Runtime.evaluate', {
    expression: `window.__exportImages = [];`,
    awaitPromise: true
  }, sessionId);
  await cdp.send('Runtime.evaluate', {
    expression: `window.__exportSpeakerNotes = ${JSON.stringify(speakerNotes)};`,
    awaitPromise: true
  }, sessionId);

  for (const file of imageFiles) {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(file, 'base64')}`;
    await cdp.send('Runtime.evaluate', {
      expression: `window.__exportImages.push(${JSON.stringify(dataUrl)});`,
      awaitPromise: true
    }, sessionId);
  }

  const result = await cdp.send('Runtime.evaluate', {
    expression: `new Promise((resolve, reject) => {
      function loadScript(src) {
        return new Promise((ok, fail) => {
          const existing = Array.from(document.scripts).find(s => s.src.endsWith(src));
          if (existing) { ok(); return; }
          const script = document.createElement('script');
          script.src = src;
          script.onload = ok;
          script.onerror = () => fail(new Error('Failed to load ' + src));
          document.head.appendChild(script);
        });
      }
      (async () => {
        await loadScript('/lib/pptxgen.bundle.js');
        const PptxCtor = window.pptxgen || window.PptxGenJS;
        if (!PptxCtor) throw new Error('PptxGenJS global was not found');
        const pptx = new PptxCtor();
        if (pptx.defineLayout) {
          pptx.defineLayout({ name: 'HTML_16_9', width: ${PPT_W}, height: ${PPT_H} });
          pptx.layout = 'HTML_16_9';
        } else {
          pptx.layout = 'LAYOUT_WIDE';
        }
        pptx.author = 'export-pptx.js';
        pptx.subject = 'Slides rendered from HTML';
        pptx.title = document.title || 'HTML PPT Export';
        pptx.company = '';
        pptx.lang = 'zh-CN';
        for (let i = 0; i < window.__exportImages.length; i++) {
          const img = window.__exportImages[i];
          const slideNumber = i + 1;
          const slide = pptx.addSlide();
          slide.background = { color: 'FFFFFF' };
          slide.addImage({ data: img, x: 0, y: 0, w: ${PPT_W}, h: ${PPT_H} });
          const note = window.__exportSpeakerNotes && window.__exportSpeakerNotes[String(slideNumber)];
          if (typeof note === 'string' && note.trim() && typeof slide.addNotes === 'function') {
            slide.addNotes(note);
          }
        }
        let data;
        try {
          data = await pptx.write({ outputType: 'base64' });
        } catch (err) {
          data = await pptx.write('base64');
        }
        if (typeof data !== 'string') throw new Error('Unexpected PPTX output type: ' + Object.prototype.toString.call(data));
        resolve(data);
      })().catch(err => reject(err));
    })`,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);

  if (!result.result || typeof result.result.value !== 'string') {
    throw new Error('PptxGenJS did not return a base64 string');
  }
  fs.writeFileSync(outFile, Buffer.from(result.result.value, 'base64'));
}

async function exportPresentation(options = {}) {
  const total = countSlides();
  if (!total) throw new Error('No slides found in template.html');
  const includeSpeakerNotes = Boolean(options.includeSpeakerNotes || process.env.INCLUDE_SPEAKER_NOTES === '1');
  const speakerNotes = includeSpeakerNotes ? readSpeakerNotes() : {};
  const chrome = findChrome();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-ppt-export-'));
  const imageFiles = [];
  const outFile = options.outFile || OUT_FILE;
  const baseUrl = options.baseUrl || `http://127.0.0.1:${PORT}`;
  const shouldStartServer = !options.baseUrl;
  const chromeDebugPort = options.chromeDebugPort || await getFreePort();
  let server = null;

  if (shouldStartServer) {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), CONTROL_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
  }

  let chromeProc = null;
  let cdp = null;
  try {
    if (shouldStartServer) await waitForServer(PORT);
    chromeProc = startChrome(chrome, chromeDebugPort);
    await waitForChrome(chromeDebugPort);
    const version = await fetchJson(`http://127.0.0.1:${chromeDebugPort}/json/version`);
    cdp = await createCdpClient(version.webSocketDebuggerUrl);
    const sessionId = await createPageSession(cdp);
    if (options.onProgress) options.onProgress({ phase: 'start', total, chrome });
    else console.log(`Exporting ${total} slides with ${chrome}`);
    for (let i = 1; i <= total; i++) {
      const outPath = path.join(tempDir, `slide-${String(i).padStart(3, '0')}.png`);
      const url = `${baseUrl}/?exportSlide=${i}`;
      if (options.onProgress) options.onProgress({ phase: 'render', current: i, total });
      else process.stdout.write(`Rendering ${i}/${total}\r`);
      await captureSlide(cdp, sessionId, url, outPath);
      imageFiles.push(outPath);
    }
    if (options.onProgress) options.onProgress({ phase: 'write', total });
    else process.stdout.write('\nWriting PPTX...\n');
    await buildPptxWithBrowserPptxGen(cdp, sessionId, imageFiles, outFile, speakerNotes);
    if (options.onProgress) options.onProgress({ phase: 'done', total, outFile });
    else console.log(`Done: ${outFile}`);
    return { outFile, slideCount: total };
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) {
      chromeProc.kill();
      try {
        fs.rmSync(chromeProc.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (err) {
        // Chrome can keep profile files open briefly after SIGTERM; the export is already complete.
      }
    }
    if (server) server.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await exportPresentation();
}

module.exports = { exportPresentation };

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
