#!/usr/bin/env node
/**
 * export-components.js
 *
 * Alternative PPTX export: instead of one screenshot per slide,
 * extracts each visual component (direct children of .body / .cover / .toc)
 * as individual screenshots and places them at their exact positions.
 *
 * The result is a PPTX where each component in a slide is a separate,
 * selectable image rather than one giant flat image.
 *
 * Usage: CONTROL_TOKEN=export-token node export-components.js
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ── Configuration ────────────────────────────────────────────────
const ROOT = __dirname;
const HTML_FILE = path.join(ROOT, '模板.html');
const OUT_FILE = path.join(ROOT, 'presentation_components.pptx');
const EDITABLE_OUT_FILE = path.join(ROOT, 'presentation_editable_text.pptx');
const EXPORT_W = 1280;
const EXPORT_H = 720;
const DEVICE_SCALE = Number(process.env.COMPONENT_EXPORT_SCALE || process.env.EXPORT_SCALE || 3);
const PORT = Number(process.env.COMPONENT_EXPORT_PORT || 3189);
const CHROME_DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9224);
const TOKEN = process.env.CONTROL_TOKEN || 'export-token';

// PPTX slide dimensions in EMU (16:9 wide, 13.333" × 7.5")
const PPT_W_EMU = 12192000;
const PPT_H_EMU = 6858000;
const PX_TO_EMU = PPT_W_EMU / EXPORT_W; // ≈ 9525

// ── Helpers (adapted from export-pptx.js) ───────────────────────

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
      const req = http.get(`http://127.0.0.1:${port}/`, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server did not start in time'));
        else setTimeout(ping, 150);
      });
      req.setTimeout(1000, () => req.destroy());
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
  throw new Error('Chrome/Chromium not found. Set CHROME_BIN env var.');
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out: ${url}`)));
  });
}

function waitForChrome(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function ping() {
      fetchJson(`http://127.0.0.1:${port}/json/version`, 1000).then(resolve).catch(() => {
        if (Date.now() - start > timeoutMs) reject(new Error('Chrome DevTools did not start'));
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
  const ws = new globalThis.WebSocket(wsUrl);

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

// ── Component extraction ────────────────────────────────────────

/**
 * Navigate to a slide URL and extract all component bounding boxes.
 * Returns { slideRect: {x,y,w,h}, components: [{id,tag,className,x,y,w,h}] }
 */
async function getSlideComponents(cdp, sessionId, url) {
  const loaded = cdp.once('Page.loadEventFired', sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await loaded;

  // Wait for fonts and two animation frames
  await cdp.send('Runtime.evaluate', {
    expression: `document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true`,
    awaitPromise: true
  }, sessionId);
  await cdp.send('Runtime.evaluate', {
    expression: `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
    awaitPromise: true
  }, sessionId);
  // Force slide to exact 1280x720 at (0,0) for reliable screenshot coordinates
  await cdp.send("Runtime.evaluate", {
    expression: `(()=>{
      var s = document.querySelector(".slide.active") || document.querySelector(".slide");
      if(s) s.setAttribute("style","position:fixed!important;left:0!important;top:0!important;"+
        "width:1280px!important;height:720px!important;margin:0!important;"+
        "max-width:none!important;max-height:none!important;transform:none!important;");
    })()`,
    awaitPromise: true
  }, sessionId);
  await cdp.send("Runtime.evaluate", {
    expression: `new Promise(r => requestAnimationFrame(r))`,
    awaitPromise: true
  }, sessionId);

  // Find all components via JS in the browser. The discovered DOM nodes are
  // tagged and later hidden directly for the clean background capture.
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const slide = document.querySelector('.slide.active') || document.querySelector('.slide');
        if (!slide) return { error: 'no slide found', components: [] };
        const sr = slide.getBoundingClientRect();
        slide.querySelectorAll('[data-export-component-id]').forEach(el => {
          delete el.dataset.exportComponentId;
        });

        // Layout wrapper classes whose children should be individual components
        var layoutClasses = ["grid","flow","vflow","wideflow","compare","pipeline",
          "branches","checklist","dualpath","minirow","bigcompare","pyramid",
          "finalmodel","timeline","matrix","evidence","kpi-row","tree","pesc",
          "case-card","case-list","swot","qa","annotation-demo","poster-grid",
          "imglib-grid","imglib-strip","zoom-layout","zoom-stack","image-table-layout",
          "image-flow","figure-parts","part-list","image-auto-grid","cover"];
        var atomicClasses = ["card","module","step","compareblock","formula","question",
          "take","fig","flowbox","vflowbox","logicline","mechanism","tagline","hint",
          "warning","counter","decision-mini","mousecard","kpi","time-card","panel",
          "patient","qa-card","poster-hero","poster-box","imglib-card","imgbox",
          "img-explain","part-chip","callout","callout-dot","target-dot"];
        function isLayout(el) {
          var c = el.className || "";
          return layoutClasses.some(function(k) { return c.split(/\s+/).indexOf(k) >= 0; });
        }
        function hasClass(el, list) {
          var c = el.className || "";
          return list.some(function(k) { return c.split(/\s+/).indexOf(k) >= 0; });
        }
        function hasVisibleBox(el) {
          var cs = getComputedStyle(el);
          var border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderRightWidth)
            + parseFloat(cs.borderBottomWidth) + parseFloat(cs.borderLeftWidth);
          var bg = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)"
            && cs.backgroundColor !== "transparent";
          return Boolean(bg || (cs.backgroundImage && cs.backgroundImage !== "none")
            || border > 0 || (cs.boxShadow && cs.boxShadow !== "none"));
        }
        function shouldSplit(el) {
          if (el.tagName === "TABLE") return false;
          if (hasClass(el, atomicClasses)) return false;
          if (isLayout(el)) return true;
          if (el.children.length > 1 && !hasVisibleBox(el)) return true;
          return false;
        }
        function isImageLike(el) {
          if (["IMG", "SVG", "CANVAS", "VIDEO"].indexOf(el.tagName) >= 0) return true;
          return hasClass(el, ["fig", "imgbox"]);
        }
        function hasText(el) {
          return (el.innerText || el.textContent || "").replace(/\s+/g, "").length > 0;
        }
        function cssNumber(value) {
          var n = parseFloat(value);
          return Number.isFinite(n) ? n : 0;
        }
        function isBold(weight) {
          return weight === "bold" || weight === "bolder" || Number(weight) >= 600;
        }
        function isItalic(style) {
          return style === "italic" || style === "oblique";
        }
        function collectTextRuns(el) {
          var runs = [];
          function pushText(text, sourceEl) {
            if (!text) return;
            var normalized = text.replace(/[\\t\\r ]+/g, " ");
            if (!normalized.replace(/\\s+/g, "")) return;
            var cs = getComputedStyle(sourceEl || el);
            runs.push({
              text: normalized,
              bold: isBold(cs.fontWeight),
              italic: isItalic(cs.fontStyle),
              color: cs.color,
              fontSize: cssNumber(cs.fontSize),
              fontFamily: cs.fontFamily || "",
              lang: /[\\u4e00-\\u9fff]/.test(normalized) ? "zh-CN" : "en-US"
            });
          }
          function walk(node, inheritedEl) {
            if (node.nodeType === Node.TEXT_NODE) {
              pushText(node.textContent, inheritedEl);
              return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            var childEl = node;
            if (childEl.tagName === "BR") {
              runs.push({ text: "\\n", break: true });
              return;
            }
            var cs = getComputedStyle(childEl);
            var block = ["block", "list-item", "table-row"].indexOf(cs.display) >= 0;
            if (block && runs.length && !runs[runs.length - 1].break) runs.push({ text: "\\n", break: true });
            Array.from(childEl.childNodes).forEach(function(child) { walk(child, childEl); });
            if (block && runs.length && !runs[runs.length - 1].break) runs.push({ text: "\\n", break: true });
          }
          Array.from(el.childNodes).forEach(function(child) { walk(child, el); });
          while (runs.length && runs[0].break) runs.shift();
          while (runs.length && runs[runs.length - 1].break) runs.pop();
          return runs;
        }
        function pseudoHasContent(el, pseudo) {
          var cs = getComputedStyle(el, pseudo);
          var content = cs && cs.content;
          return Boolean(content && content !== "none" && content !== "normal" && content !== '""' && content !== "''");
        }
        function nativeTextInfo(el) {
          var cs = getComputedStyle(el);
          var text = (el.innerText || el.textContent || "").replace(/\\s+$/g, "");
          var hasMedia = Boolean(el.querySelector("img,svg,canvas,video"));
          var hasSpecialText = cs.textShadow && cs.textShadow !== "none";
          var transformed = cs.transform && cs.transform !== "none";
          var pseudoText = pseudoHasContent(el, "::before") || pseudoHasContent(el, "::after");
          var runs = collectTextRuns(el);
          var eligible = Boolean(text.replace(/\\s+/g, ""))
            && !hasMedia
            && !hasSpecialText
            && !transformed
            && !pseudoText
            && runs.length <= 80;
          return {
            eligible: eligible,
            reason: eligible ? "" : (hasMedia ? "media" : hasSpecialText ? "text-shadow" : transformed ? "transform" : pseudoText ? "pseudo" : "complex"),
            text: text,
            runs: runs,
            fontFamily: cs.fontFamily || "",
            fontSize: cssNumber(cs.fontSize),
            color: cs.color,
            bold: isBold(cs.fontWeight),
            italic: isItalic(cs.fontStyle),
            textAlign: cs.textAlign || "left",
            verticalAlign: cs.verticalAlign || "top",
            lineHeight: cs.lineHeight === "normal" ? 0 : cssNumber(cs.lineHeight),
            singleLine: text.indexOf("\\n") < 0,
            padding: {
              top: cssNumber(cs.paddingTop),
              right: cssNumber(cs.paddingRight),
              bottom: cssNumber(cs.paddingBottom),
              left: cssNumber(cs.paddingLeft)
            }
          };
        }
        function pushItem(el, kind, capture, layer, seq) {
          var r = el.getBoundingClientRect();
          if (r.width <= 2 || r.height <= 2) return;
          var targetId = el.dataset.exportComponentId;
          if (!targetId) {
            targetId = "e" + targetCount++;
            el.dataset.exportComponentId = targetId;
          }
          comps.push({
              id: "c" + comps.length,
              targetId: targetId,
              kind: kind,
              capture: capture,
              layer: layer,
              seq: seq,
              tag: el.tagName,
              cls: (el.className || "").slice(0, 80),
              x: r.x - sr.x,
              y: r.y - sr.y,
              w: r.width,
              h: r.height,
              text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50),
              nativeText: kind === "text" ? nativeTextInfo(el) : null
            });
        }
        function addComponent(el) {
          var seq = componentSeq++;
          var text = hasText(el);
          var visibleBox = hasVisibleBox(el);
          if (el.tagName === "TABLE") {
            pushItem(el, "frame", visibleBox ? "frame" : "normal", 0, seq);
            Array.from(el.querySelectorAll("th,td")).forEach(function(cell) {
              if (hasText(cell)) pushItem(cell, "text", "text", 2, seq);
            });
          } else if (isImageLike(el)) {
            pushItem(el, "image", "normal", 1, seq);
          } else if (visibleBox && text) {
            pushItem(el, "frame", "frame", 0, seq);
            pushItem(el, "text", "text", 2, seq);
          } else if (text) {
            pushItem(el, "text", "text", 2, seq);
          } else {
            pushItem(el, "frame", "normal", 0, seq);
          }
        }
        function collect(el) {
          var r = el.getBoundingClientRect();
          if (r.width <= 2 || r.height <= 2) return;
          if (shouldSplit(el)) {
            Array.from(el.children).forEach(collect);
          } else {
            addComponent(el);
          }
        }
        function hasOwnText(el) {
          return Array.from(el.childNodes).some(function(node) {
            return node.nodeType === Node.TEXT_NODE && node.textContent.replace(/\s+/g, "").length > 0;
          });
        }
        var comps = [];
        var targetCount = 0;
        var componentSeq = 0;
        var roots = [];
        function addRoot(el) {
          if (el && roots.indexOf(el) < 0) roots.push(el);
        }
        addRoot(slide.querySelector('.page-num'));
        addRoot(slide.querySelector('.slidebar'));
        var coverText = slide.querySelector('.cover-text');
        var coverImg = slide.querySelector('.cover-img');
        addRoot(coverText);
        addRoot(coverImg);
        addRoot(slide.querySelector('.body'));
        if (!coverText && !coverImg) addRoot(slide.querySelector('.cover'));
        addRoot(slide.querySelector('.toc'));
        addRoot(slide.querySelector('.task-cover'));
        addRoot(slide.querySelector('.layout-note'));
        addRoot(slide.querySelector('.note-ribbon'));

        roots.forEach(function(root) {
          if (root.matches && (root.matches('.page-num') || root.matches('.layout-note') || root.matches('.note-ribbon'))) {
            collect(root);
          } else if (root.matches && root.matches('.slidebar')) {
            Array.from(root.children).forEach(collect);
          } else {
            Array.from(root.children).forEach(collect);
          }
        });

        Array.from(slide.querySelectorAll('*')).forEach(function(el) {
          if (el.closest('[data-export-component-id]')) return;
          if (["SCRIPT", "STYLE", "LINK", "META"].indexOf(el.tagName) >= 0) return;
          if (Array.from(el.children).some(function(child) { return child.tagName !== "BR"; })) return;
          if (!hasOwnText(el)) return;
          var r = el.getBoundingClientRect();
          if (r.width <= 2 || r.height <= 2) return;
          addComponent(el);
        });

        comps.sort(function(a, b) {
          if (a.layer !== b.layer) return a.layer - b.layer;
          if (a.seq !== b.seq) return a.seq - b.seq;
          return a.id.localeCompare(b.id);
        });

        return {
          slideX: sr.x, slideY: sr.y, slideW: sr.w, slideH: sr.h,
          components: comps
        };
      })()
    `,
    returnByValue: true,
    awaitPromise: true
  }, sessionId);

  const data = result.result.value;
  if (data.error) throw new Error(data.error);
  return data;
}

/**
 * Take a full-slide screenshot (background).
 */
async function captureFullSlide(cdp, sessionId, filePath) {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  }, sessionId);
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
}

/**
 * Take a clipped screenshot of a single component.
 */
async function captureComponent(cdp, sessionId, comp, filePath) {
  const isolate = comp.capture === 'frame' || comp.capture === 'text';
  try {
    if (isolate) {
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
        color: { r: 0, g: 0, b: 0, a: 0 }
      }, sessionId);
      const mode = JSON.stringify(comp.capture);
      const targetId = JSON.stringify(comp.targetId);
      await cdp.send('Runtime.evaluate', {
        expression: `
        (function(){
          const mode = ${mode};
          const targetId = ${targetId};
          const slide = document.querySelector(".slide.active") || document.querySelector(".slide");
          if (!slide) return;
          const target = slide.querySelector('[data-export-component-id="' + targetId.replace(/"/g, '\\\\"') + '"]');
          if (!target) return;
          const props = ["visibility","background","backgroundColor","backgroundImage","borderColor",
            "borderTopColor","borderRightColor","borderBottomColor","borderLeftColor",
            "boxShadow","outlineColor","color","textShadow","webkitTextFillColor"];
          window.__componentCaptureRestore = [];
          function save(el) {
            const rec = { el: el, style: {} };
            props.forEach(function(p){ rec.style[p] = el.style[p] || ""; });
            window.__componentCaptureRestore.push(rec);
          }
          function setStyle(el, values) {
            save(el);
            Object.keys(values).forEach(function(k){ el.style[k] = values[k]; });
          }
          setStyle(document.documentElement, { background: "transparent", backgroundColor: "transparent", backgroundImage: "none" });
          setStyle(document.body, { background: "transparent", backgroundColor: "transparent", backgroundImage: "none" });
          setStyle(slide, {
            background: "transparent",
            backgroundColor: "transparent",
            backgroundImage: "none",
            borderColor: "transparent",
            boxShadow: "none"
          });
          Array.from(slide.querySelectorAll("*")).forEach(function(el) {
            const related = el === target || target.contains(el) || el.contains(target);
            if (!related) setStyle(el, { visibility: "hidden" });
          });
          const targetTree = [target].concat(Array.from(target.querySelectorAll("*")));
          const ancestorTree = [];
          let ancestor = target.parentElement;
          while (ancestor && ancestor !== slide) {
            ancestorTree.push(ancestor);
            ancestor = ancestor.parentElement;
          }
          if (mode === "frame") {
            targetTree.forEach(function(el) {
              setStyle(el, {
                color: "transparent",
                webkitTextFillColor: "transparent",
                textShadow: "none"
              });
            });
          } else if (mode === "text") {
            targetTree.concat(ancestorTree).forEach(function(el) {
              setStyle(el, {
                background: "transparent",
                backgroundColor: "transparent",
                backgroundImage: "none",
                borderColor: "transparent",
                borderTopColor: "transparent",
                borderRightColor: "transparent",
                borderBottomColor: "transparent",
                borderLeftColor: "transparent",
                boxShadow: "none",
                outlineColor: "transparent"
              });
            });
          }
          const style = document.createElement("style");
          style.setAttribute("data-component-capture-style", "1");
          style.textContent = '[data-export-component-id="' + targetId.replace(/"/g, '\\\\"') + '"]::before,[data-export-component-id="' + targetId.replace(/"/g, '\\\\"') + '"]::after{' +
            (mode === "frame"
              ? 'color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;'
              : 'background:transparent!important;background-image:none!important;border-color:transparent!important;box-shadow:none!important;outline-color:transparent!important;') +
            '}';
          document.head.appendChild(style);
          window.__componentCaptureRestore.push({ el: style, remove: true });
        })()
      `,
        awaitPromise: true
      }, sessionId);
      await cdp.send('Runtime.evaluate', {
        expression: `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
        awaitPromise: true
      }, sessionId);
    }

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: comp.x,
        y: comp.y,
        width: comp.w,
        height: comp.h,
        scale: 1
      },
      fromSurface: true,
      captureBeyondViewport: false
    }, sessionId);
    fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));

  } finally {
    if (isolate) {
      try {
        await cdp.send('Runtime.evaluate', {
          expression: `
        (function(){
          const restore = window.__componentCaptureRestore || [];
          for (let i = restore.length - 1; i >= 0; i--) {
            const rec = restore[i];
            if (rec.remove && rec.el && rec.el.parentNode) {
              rec.el.parentNode.removeChild(rec.el);
            } else if (rec.el && rec.style) {
              Object.keys(rec.style).forEach(function(k){ rec.el.style[k] = rec.style[k]; });
            }
          }
          window.__componentCaptureRestore = [];
        })()
      `,
          awaitPromise: true
        }, sessionId);
      } finally {
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {}, sessionId);
      }
    }
  }
}

// ── PPTX builder ────────────────────────────────────────────────

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
  const d = date || new Date();
  return {
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    dosDate: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function createZip(entries) {
  const fileData = [];
  const central = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

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
    fileData.push(local, data);

    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 38);
    cen.writeUInt16LE(0, 40);
    cen.writeUInt32LE(offset, 42);
    name.copy(cen, 46);
    central.push(cen);

    offset += local.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...fileData, centralBuf, eocd]);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function cssColorToHex(color, fallback = '000000') {
  const text = String(color || '').trim();
  let match = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (match) {
    const hex = match[1];
    return hex.length === 3
      ? hex.split('').map(ch => ch + ch).join('').toUpperCase()
      : hex.toUpperCase();
  }
  match = text.match(/^rgba?\(([^)]+)\)$/i);
  if (!match) return fallback;
  const parts = match[1].split(',').map(part => Number(String(part).trim().replace('%', '')));
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return fallback;
  return parts.slice(0, 3)
    .map(value => clampInt(value, 0, 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function cssFontFamilyToPpt(fontFamily) {
  return String(fontFamily || 'Arial')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '') || 'Arial';
}

function buildContentTypes(slides) {
  let overrides = '';
  for (let si = 0; si < slides.length; si++) {
    const slideNum = si + 1;
    overrides += `<Override PartName="/ppt/slides/slide${slideNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    // bg image
    overrides += `<Override PartName="/ppt/media/s${slideNum}_bg.png" ContentType="image/png"/>`;
    // component images
    for (let ci = 0; ci < slides[si].components.length; ci++) {
      overrides += `<Override PartName="/ppt/media/s${slideNum}_c${ci}.png" ContentType="image/png"/>`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${overrides}
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`;
}

function buildPresentationXml(slideCount) {
  const ids = Array.from({ length: slideCount }, (_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldSz cx="${PPT_W_EMU}" cy="${PPT_H_EMU}" type="wide"/>
<p:notesSz cx="6858000" cy="9144000"/>
<p:sldIdLst>${ids}</p:sldIdLst>
</p:presentation>`;
}

function buildPresentationRels(slideCount) {
  const rels = [];
  rels.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`);
  for (let i = 1; i <= slideCount; i++) {
    rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i}.xml"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

function buildThemeXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>
<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements>
<a:objectDefaults/><a:extraClrSchemeLst/>
</a:theme>`;
}

function buildSlideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`;
}

function buildSlideMasterRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function buildSlideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function buildSlideLayoutRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function buildSlideXml(slideIndex, comps, options = {}) {
  let shapeId = 2;

  function picXml(relId, xEmu, yEmu, wEmu, hEmu, name) {
    const id = shapeId++;
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="${xEmu}" y="${yEmu}"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }

  function textRunXml(run, fallback) {
    const text = run && run.text != null ? String(run.text) : '';
    if (!text) return '';
    const fontSizePx = Number(run.fontSize || fallback.fontSize || 16);
    const fontSize = clampInt(fontSizePx * 75, 100, 12000);
    const fontFace = xmlEscape(cssFontFamilyToPpt(run.fontFamily || fallback.fontFamily));
    const color = cssColorToHex(run.color || fallback.color, '000000');
    const lang = xmlEscape(run.lang || 'zh-CN');
    const bold = run.bold ? ' b="1"' : '';
    const italic = run.italic ? ' i="1"' : '';
    return `<a:r><a:rPr lang="${lang}" sz="${fontSize}"${bold}${italic}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${fontFace}"/><a:ea typeface="${fontFace}"/><a:cs typeface="${fontFace}"/></a:rPr><a:t>${xmlEscape(text)}</a:t></a:r>`;
  }

  function splitRunsToParagraphs(runs, fallbackText) {
    const source = Array.isArray(runs) && runs.length ? runs : [{ text: fallbackText || '' }];
    const paragraphs = [[]];
    for (const run of source) {
      const text = run && run.text != null ? String(run.text) : '';
      if (run && run.break) {
        paragraphs.push([]);
        continue;
      }
      const parts = text.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) paragraphs.push([]);
        if (part) paragraphs[paragraphs.length - 1].push({ ...run, text: part });
      });
    }
    return paragraphs.length ? paragraphs : [[]];
  }

  function textXml(comp, xEmu, yEmu, wEmu, hEmu, name) {
    const id = shapeId++;
    const info = comp.nativeText || {};
    const padding = info.padding || {};
    const lIns = Math.round((Number(padding.left) || 0) * PX_TO_EMU);
    const rIns = Math.round((Number(padding.right) || 0) * PX_TO_EMU);
    const tIns = Math.round((Number(padding.top) || 0) * PX_TO_EMU);
    const bIns = Math.round((Number(padding.bottom) || 0) * PX_TO_EMU);
    const alignMap = { center: 'ctr', right: 'r', end: 'r', left: 'l', start: 'l' };
    const algn = alignMap[info.textAlign] || 'l';
    const fontSizePx = Number(info.fontSize || 16);
    const defaultSize = clampInt(fontSizePx * 75, 100, 12000);
    const defaultFont = xmlEscape(cssFontFamilyToPpt(info.fontFamily));
    const defaultColor = cssColorToHex(info.color, '000000');
    const lineHeight = Number(info.lineHeight || 0);
    const lnSpc = lineHeight > 0 ? `<a:lnSpc><a:spcPts val="${clampInt(lineHeight * 75, 100, 12000)}"/></a:lnSpc>` : '';
    const fallback = {
      fontSize: fontSizePx,
      fontFamily: info.fontFamily || 'Arial',
      color: info.color || 'rgb(0, 0, 0)'
    };
    const paragraphs = splitRunsToParagraphs(info.runs, info.text || comp.text || '');
    const wrap = info.singleLine ? 'none' : 'square';
    const parasXml = paragraphs.map(paragraphRuns => {
      const runsXml = paragraphRuns.map(run => textRunXml(run, fallback)).join('');
      return `<a:p><a:pPr algn="${algn}">${lnSpc}</a:pPr>${runsXml}<a:endParaRPr lang="zh-CN" sz="${defaultSize}"><a:solidFill><a:srgbClr val="${defaultColor}"/></a:solidFill><a:latin typeface="${defaultFont}"/><a:ea typeface="${defaultFont}"/><a:cs typeface="${defaultFont}"/></a:endParaRPr></a:p>`;
    }).join('');
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${xEmu}" y="${yEmu}"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
<p:txBody><a:bodyPr wrap="${wrap}" lIns="${lIns}" tIns="${tIns}" rIns="${rIns}" bIns="${bIns}" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${parasXml}</p:txBody></p:sp>`;
  }

  let imagesXml = '';
  // Background: uses rId1, covers entire slide
  imagesXml += picXml('rId1', 0, 0, PPT_W_EMU, PPT_H_EMU, `Slide ${slideIndex} Background`);

  // Components: use rId2, rId3, ... for captured PNG layers.
  comps.forEach((comp, ci) => {
    const relId = `rId${Number(comp.mediaIndex) + 2}`;
    const xEmu = Math.round(comp.x * PX_TO_EMU);
    const yEmu = Math.round(comp.y * PX_TO_EMU);
    const wEmu = Math.round(comp.w * PX_TO_EMU);
    const hEmu = Math.round(comp.h * PX_TO_EMU);
    if (options.editableText && comp.renderAs === 'nativeText') {
      imagesXml += textXml(comp, xEmu, yEmu, wEmu, hEmu, `Editable Text ${ci + 1}`);
    } else {
      imagesXml += picXml(relId, xEmu, yEmu, wEmu, hEmu, `Component ${ci + 1}`);
    }
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${imagesXml}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function buildSlideRels(slideIndex, components) {
  const rels = [];
  rels.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/s${slideIndex}_bg.png"/>`);
  const imageComponents = components.filter(comp => comp.renderAs !== 'nativeText');
  for (const comp of imageComponents) {
    const mediaIndex = Number(comp.mediaIndex);
    rels.push(`<Relationship Id="rId${mediaIndex + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/s${slideIndex}_c${mediaIndex}.png"/>`);
  }
  rels.push(`<Relationship Id="rId${imageComponents.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
}

function buildPptx(slides, outFile, options = {}) {
  const now = new Date().toISOString();
  const entries = [];

  // [Content_Types].xml
  entries.push({ name: '[Content_Types].xml', data: buildContentTypes(slides) });

  // _rels/.rels
  entries.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` });

  // docProps
  entries.push({ name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape('HTML PPT Component Export')}</dc:title><dc:creator>export-components.js</dc:creator><cp:lastModifiedBy>export-components.js</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` });
  entries.push({ name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>export-components.js</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slides.length}</Slides></Properties>` });

  // ppt/presentation.xml + rels
  entries.push({ name: 'ppt/presentation.xml', data: buildPresentationXml(slides.length) });
  entries.push({ name: 'ppt/_rels/presentation.xml.rels', data: buildPresentationRels(slides.length) });
  entries.push({ name: 'ppt/theme/theme1.xml', data: buildThemeXml() });
  entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: buildSlideMasterXml() });
  entries.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: buildSlideMasterRels() });
  entries.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: buildSlideLayoutXml() });
  entries.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: buildSlideLayoutRels() });

  // Each slide
  for (let si = 0; si < slides.length; si++) {
    const s = slides[si];
    const slideNum = si + 1;

    // slide XML
    entries.push({ name: `ppt/slides/slide${slideNum}.xml`, data: buildSlideXml(slideNum, s.components, options) });

    // slide rels
    entries.push({ name: `ppt/slides/_rels/slide${slideNum}.xml.rels`, data: buildSlideRels(slideNum, s.components) });

    // media: background image
    entries.push({ name: `ppt/media/s${slideNum}_bg.png`, data: fs.readFileSync(s.bgFile) });

    // media: component images
    s.compFiles.forEach((cf, ci) => {
      entries.push({ name: `ppt/media/s${slideNum}_c${ci}.png`, data: fs.readFileSync(cf) });
    });
  }

  fs.writeFileSync(outFile, createZip(entries));
  console.log(`Wrote ${outFile}`);
}

// ── Main export pipeline ────────────────────────────────────────

async function exportComponents(options = {}) {
  const total = countSlides();
  if (!total) throw new Error('No slides found in 模板.html');

  const exportMode = options.mode || process.env.COMPONENT_EXPORT_MODE || 'advanced';
  const editableText = exportMode === 'editable';
  const chromeExe = findChrome();
  const chromeDebugPort = options.chromeDebugPort || await getFreePort();
  const baseUrl = options.baseUrl || `http://127.0.0.1:${PORT}`;
  const outFile = options.outFile || (editableText ? EDITABLE_OUT_FILE : OUT_FILE);
  const shouldStartServer = !options.baseUrl;
  let server = null;
  let tempDir = null;

  if (shouldStartServer) {
    console.log(`Starting server on port ${PORT}...`);
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
    if (shouldStartServer) {
      await waitForServer(PORT);
      console.log(`Server ready on port ${PORT}`);
    }

    chromeProc = startChrome(chromeExe, chromeDebugPort);
    await waitForChrome(chromeDebugPort);
    const version = await fetchJson(`http://127.0.0.1:${chromeDebugPort}/json/version`);
    console.log(`Chrome connected: ${version.Browser || ''}`);

    cdp = createCdpClient(version.webSocketDebuggerUrl);
    cdp = await cdp; // Wait for WebSocket to open

    const sessionId = await createPageSession(cdp);

    const slides = [];
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'component-export-'));

    for (let i = 1; i <= total; i++) {
      const url = `${baseUrl}/?exportSlide=${i}`;
      if (options.onProgress) options.onProgress({ phase: 'components', current: i, total });
      else process.stdout.write(`\nSlide ${i}/${total}: discovering components... `);

      // Get component positions
      const data = await getSlideComponents(cdp, sessionId, url);

      if (data.error) {
        console.error('Error:', data.error);
        continue;
      }

      const components = data.components;
      if (editableText) {
        for (const comp of components) {
          if (comp.kind === 'text' && comp.nativeText && comp.nativeText.eligible) {
            comp.renderAs = 'nativeText';
          } else if (comp.kind === 'text') {
            comp.renderAs = 'pngText';
          } else {
            comp.renderAs = 'image';
          }
        }
      }
      if (options.onProgress) {
        console.log(`Advanced export slide ${i}/${total}: ${components.length} component(s)`);
      } else {
        console.log(`${components.length} component(s)`);
      }

      // Log what we found
      for (const comp of components) {
        console.log(`  [${comp.id}] ${comp.kind}/${comp.capture} ${comp.cls.slice(0, 50)} (${comp.w}×${comp.h} @ ${comp.x},${comp.y})`);
      }

      // Hide the exact component elements discovered on the active slide so
      // the background screenshot does not duplicate movable components.
      await cdp.send("Runtime.evaluate", {
        expression: `(function(){
          var slide=document.querySelector(".slide.active")||document.querySelector(".slide");
          if(!slide)return;
          slide.querySelectorAll("[data-export-component-id]").forEach(function(el){
            el.dataset._v=el.style.visibility;
            el.style.visibility="hidden";
          });
        })()`,
        awaitPromise: true
      }, sessionId);
      await cdp.send("Runtime.evaluate", {
        expression: `new Promise(r => requestAnimationFrame(r))`,
        awaitPromise: true
      }, sessionId);

      // Take background screenshot (full slide, components hidden)
      const bgFile = path.join(tempDir, `s${i}_bg.png`);
      if (!options.onProgress) process.stdout.write(`  Background screenshot... `);
      await captureFullSlide(cdp, sessionId, bgFile);
      if (!options.onProgress) console.log('done');

      // Restore component visibility
      await cdp.send("Runtime.evaluate", {
        expression: `(document.querySelector(".slide.active")||document).querySelectorAll("[data-_v]").forEach(function(el){
          el.style.visibility=el.dataset._v||"";delete el.dataset._v;
        })`,
        awaitPromise: true
      }, sessionId);
      await cdp.send("Runtime.evaluate", {
        expression: `new Promise(r => requestAnimationFrame(r))`,
        awaitPromise: true
      }, sessionId);

      // Take each component screenshot
      const compFiles = [];
      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        if (editableText && comp.renderAs === 'nativeText') continue;
        comp.mediaIndex = compFiles.length;
        const cf = path.join(tempDir, `s${i}_c${comp.mediaIndex}.png`);
        compFiles.push(cf);
        await captureComponent(cdp, sessionId, comp, cf);
      }
      if (!options.onProgress) console.log(`  ${compFiles.length} component screenshot(s)`);

      slides.push({ components, bgFile, compFiles });
    }

    if (options.onProgress) options.onProgress({ phase: 'write', total });
    else process.stdout.write('\nBuilding PPTX... ');
    buildPptx(slides, outFile, { editableText });
    if (!options.onProgress) console.log(`\nDone: ${outFile} (${total} slides)`);

    if (options.onProgress) options.onProgress({ phase: 'done', total, outFile });
    return { outFile, slideCount: total };

  } finally {
    if (cdp) {
      try { cdp.close(); } catch {}
    }
    if (chromeProc) {
      chromeProc.kill();
      try { fs.rmSync(chromeProc.profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
    }
    if (server) server.kill();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Run ─────────────────────────────────────────────────────────

if (require.main === module) {
  exportComponents().catch(err => {
    console.error('\nError:', err.message || err);
    process.exit(1);
  });
}

module.exports = { exportComponents };
