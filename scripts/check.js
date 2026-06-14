#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'template.html');
const ASSET_SCRIPTS = [
  'assets/presenter.js',
  'assets/frontend-export.js',
  'assets/canvas-scaler.js',
  'assets/image-tools.js'
];

function fail(message) {
  throw new Error(message);
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fail(`${command} ${args.join(' ')} failed`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${label} is invalid JSON: ${err.message}`);
  }
}

function assertEqualJson(a, b, label) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`${label} mismatch`);
  }
}

function checkPackageJson() {
  parseJson(read('package.json'), 'package.json');
  console.log('package.json ok');
}

function checkNodeSyntax() {
  run(process.execPath, ['--check', 'export-pptx.js']);
  run(process.execPath, ['--check', 'export-components.js']);
  run(process.execPath, ['--check', 'server.js']);
  run(process.execPath, ['--check', 'scripts/sync-speaker-notes.js']);
  for (const file of ASSET_SCRIPTS) {
    run(process.execPath, ['--check', file]);
  }
  console.log('node syntax ok');
}

function checkMarkdownFences() {
  for (const file of ['README.md', 'agent-ppt/SKILL.md', 'agent-ppt/references/template-syntax.md']) {
    const count = (read(file).match(/```/g) || []).length;
    if (count % 2) fail(`${file} has unmatched code fences`);
  }
  console.log('markdown fences ok');
}

function checkHtmlScripts(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*type=["']application\/json["'])(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  scripts.forEach((match, index) => {
    try {
      new Function(match[1]);
    } catch (err) {
      fail(`executable HTML script ${index + 1} has syntax error: ${err.message}`);
    }
  });
  console.log(`html scripts ok (${scripts.length})`);
}

function checkTemplateAssets(html) {
  if (!html.includes('<link rel="stylesheet" href="assets/template.css"/>')) {
    fail('template stylesheet reference is missing');
  }
  for (const file of ASSET_SCRIPTS) {
    if (!html.includes(`<script src="${file}"></script>`)) {
      fail(`${file} script reference is missing`);
    }
  }
  console.log('template assets ok');
}

function checkSpeakerNotes(html) {
  const notes = parseJson(read('speaker-notes.json'), 'speaker-notes.json');
  const match = html.match(/<script\s+id="speaker-notes-data"\s+type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) fail('speaker-notes-data script is missing');
  const embedded = parseJson(match[1], 'speaker-notes-data');
  assertEqualJson(embedded, notes, 'speaker notes');
  console.log('speaker notes sync ok');
}

function checkSlides(html) {
  const slideMatches = [...html.matchAll(/<section\s+class="[^"]*\bslide\b[\s\S]*?<\/section>/g)];
  const slideCount = slideMatches.length;
  if (!slideCount) fail('no slides found');

  const pageNums = [...html.matchAll(/<div class="page-num">(\d+)\/(\d+)<\/div>/g)].map(match => ({
    page: Number(match[1]),
    total: Number(match[2])
  }));
  if (pageNums.length !== slideCount) fail(`page-num count ${pageNums.length} does not match slide count ${slideCount}`);
  pageNums.forEach((item, index) => {
    if (item.page !== index + 1 || item.total !== slideCount) {
      fail(`bad page-num at slide ${index + 1}: ${item.page}/${item.total}, expected ${index + 1}/${slideCount}`);
    }
  });

  const notes = parseJson(read('speaker-notes.json'), 'speaker-notes.json');
  const missingNotes = [];
  for (let i = 1; i <= slideCount; i++) {
    if (!Object.prototype.hasOwnProperty.call(notes, String(i))) missingNotes.push(i);
  }
  if (missingNotes.length) fail(`speaker-notes.json missing slide keys: ${missingNotes.join(', ')}`);
  console.log(`slides ok (${slideCount})`);
}

function checkExportUi(html) {
  const modes = [...html.matchAll(/data-export-mode="([^"]+)"/g)].map(match => match[1]);
  const expected = ['client', 'normal', 'advanced', 'editable'];
  assertEqualJson(modes, expected, 'export modes');
  if (!html.includes('纯前端导出')) fail('pure frontend export label missing');
  if (!html.includes('服务端普通')) fail('server normal export label missing');
  if (!html.includes('服务端高级')) fail('server advanced export label missing');
  if (!html.includes('服务端可编辑文字')) fail('server editable export label missing');
  console.log('export ui ok');
}

function checkExplicitExportMarkers(html) {
  const splitCount = (html.match(/data-export-component="split"/g) || []).length;
  const componentCount = (html.match(/data-export-component="component"/g) || []).length;
  if (splitCount < 20) fail(`too few explicit split export markers: ${splitCount}`);
  if (componentCount < 20) fail(`too few explicit component export markers: ${componentCount}`);
  if (!html.includes('class="body" data-export-component="split"')) {
    fail('slide body containers must be explicit export split containers');
  }
  console.log(`explicit export markers ok (${splitCount} split, ${componentCount} component)`);
}

function checkExportDefaults() {
  const fullSlide = read('export-pptx.js');
  const components = read('export-components.js');
  const frontendExport = read('assets/frontend-export.js');
  if (!fullSlide.includes('process.env.EXPORT_SCALE || 3')) fail('export-pptx.js default scale is not 3');
  if (!components.includes("process.env.EXPORT_SCALE || 3")) fail('export-components.js default scale is not 3');
  if (!frontendExport.includes('var EXPORT_SCALE = 3;')) fail('frontend export default scale is not 3');
  if (!components.includes('<a:normAutofit fontScale="100000" lnSpcReduction="0"/>')) {
    fail('editable text export does not use wrapping-friendly autofit');
  }
  console.log('export defaults ok');
}

function main() {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  checkPackageJson();
  checkNodeSyntax();
  checkMarkdownFences();
  checkTemplateAssets(html);
  checkHtmlScripts(html);
  checkSpeakerNotes(html);
  checkSlides(html);
  checkExportUi(html);
  checkExplicitExportMarkers(html);
  checkExportDefaults();
  console.log('all checks passed');
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
