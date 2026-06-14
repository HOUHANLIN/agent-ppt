const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { exportPresentation } = require('./export-pptx');
const { exportComponents } = require('./export-components');

const rootDir = __dirname;
const port = Number(process.env.PORT || 3000);
const controlToken = process.env.CONTROL_TOKEN;

if (!controlToken) {
  console.error('Missing CONTROL_TOKEN. Start with: CONTROL_TOKEN=your-secret PORT=3000 node server.js');
  process.exit(1);
}

let currentPage = 0;
let currentTotal = null;
let eventId = 0;
const clients = new Set();
let exportInProgress = false;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function getRequestToken(req, parsedUrl, body) {
  return (
    req.headers['x-control-token'] ||
    parsedUrl.searchParams.get('token') ||
    (body && body.token)
  );
}

function pagePayload() {
  return {
    page: currentPage,
    total: currentTotal,
    updatedAt: new Date().toISOString()
  };
}

function writeSse(res, event, payload) {
  res.write(`id: ${++eventId}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastPage() {
  const payload = pagePayload();
  for (const res of clients) {
    writeSse(res, 'page', payload);
  }
}

function serveStatic(req, res, parsedUrl) {
  let pathname = decodeURIComponent(parsedUrl.pathname);
  if (pathname === '/') pathname = '/template.html';

  const filePath = path.normalize(path.join(rootDir, pathname));
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  if (filePath === path.join(rootDir, 'speaker-notes.json')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && parsedUrl.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    clients.add(res);
    writeSse(res, 'page', pagePayload());

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/control') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }

    if (getRequestToken(req, parsedUrl, body) !== controlToken) {
      sendJson(res, 401, { ok: false, error: 'Invalid control token' });
      return;
    }

    const page = Number(body.page);
    const total = body.total == null ? null : Number(body.total);
    if (!Number.isInteger(page) || page < 0) {
      sendJson(res, 400, { ok: false, error: 'Invalid page' });
      return;
    }
    if (total != null && (!Number.isInteger(total) || total <= 0 || page >= total)) {
      sendJson(res, 400, { ok: false, error: 'Page is out of range' });
      return;
    }

    currentPage = page;
    currentTotal = total;
    broadcastPage();
    sendJson(res, 200, { ok: true, ...pagePayload() });
    return;
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/export-pptx') {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }

    if (getRequestToken(req, parsedUrl, body) !== controlToken) {
      sendJson(res, 401, { ok: false, error: 'Invalid control token' });
      return;
    }

    if (exportInProgress) {
      sendJson(res, 409, { ok: false, error: 'An export is already in progress' });
      return;
    }

    const requestedMode = body && body.mode;
    const mode = requestedMode === 'advanced' || requestedMode === 'editable' ? requestedMode : 'normal';
    const exporter = mode === 'normal' ? exportPresentation : exportComponents;
    const downloadName = mode === 'editable'
      ? 'presentation_editable_text.pptx'
      : mode === 'advanced'
        ? 'presentation_components.pptx'
        : 'presentation_exported_script.pptx';

    exportInProgress = true;
    const outFile = path.join(os.tmpdir(), `html-ppt-${mode}-export-${Date.now()}.pptx`);
    try {
      await exporter({
        mode,
        baseUrl: `http://127.0.0.1:${port}`,
        outFile,
        onProgress(info) {
          if (info.phase === 'render') {
            console.log(`${mode} export rendering ${info.current}/${info.total}`);
          } else if (info.phase === 'components') {
            console.log(`${mode} export components ${info.current}/${info.total}`);
          } else if (info.phase === 'write') {
            console.log(`${mode} export writing PPTX`);
          }
        }
      });
      const file = fs.readFileSync(outFile);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': `attachment; filename="${downloadName}"`,
        'Content-Length': file.length,
        'Cache-Control': 'no-store'
      });
      res.end(file);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    } finally {
      exportInProgress = false;
      fs.rmSync(outFile, { force: true });
    }
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/speaker-notes') {
    if (getRequestToken(req, parsedUrl) !== controlToken) {
      sendJson(res, 401, { ok: false, error: 'Invalid control token' });
      return;
    }

    fs.readFile(path.join(rootDir, 'speaker-notes.json'), 'utf8', (err, text) => {
      if (err) {
        sendJson(res, 404, { ok: false, error: 'Speaker notes file not found' });
        return;
      }
      try {
        const notes = JSON.parse(text);
        if (!notes || Array.isArray(notes) || typeof notes !== 'object') {
          throw new Error('Invalid notes JSON');
        }
        sendJson(res, 200, notes);
      } catch (parseErr) {
        sendJson(res, 500, { ok: false, error: parseErr.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && parsedUrl.pathname === '/api/state') {
    sendJson(res, 200, { ok: true, ...pagePayload() });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  serveStatic(req, res, parsedUrl);
});

server.listen(port, () => {
  console.log(`HTML PPT server running at http://localhost:${port}/`);
  console.log(`Controller: http://localhost:${port}/?role=control&token=${encodeURIComponent(controlToken)}`);
  console.log(`Audience:   http://localhost:${port}/?role=audience`);
});
