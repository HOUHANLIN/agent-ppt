#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'template.html');
const NOTES_FILE = path.join(ROOT, 'speaker-notes.json');
const CHECK_ONLY = process.argv.includes('--check');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function extractEmbeddedNotes(html) {
  const match = html.match(/<script\s+id="speaker-notes-data"\s+type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find <script id="speaker-notes-data" type="application/json"> in template.html');
  return {
    fullMatch: match[0],
    jsonText: match[1]
  };
}

function main() {
  const notes = readJson(NOTES_FILE);
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const embedded = extractEmbeddedNotes(html);
  const nextJson = normalizeJson(notes).trimEnd();
  const nextScript = `<script id="speaker-notes-data" type="application/json">${nextJson}</script>`;

  if (CHECK_ONLY) {
    const embeddedNotes = JSON.parse(embedded.jsonText);
    const current = normalizeJson(embeddedNotes);
    const expected = normalizeJson(notes);
    if (current !== expected) {
      throw new Error('Embedded speaker notes are out of sync. Run: npm run sync-notes');
    }
    console.log('speaker notes are in sync');
    return;
  }

  if (embedded.fullMatch === nextScript) {
    console.log('speaker notes already in sync');
    return;
  }

  fs.writeFileSync(HTML_FILE, html.replace(embedded.fullMatch, nextScript));
  console.log('synced speaker-notes.json into template.html');
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
