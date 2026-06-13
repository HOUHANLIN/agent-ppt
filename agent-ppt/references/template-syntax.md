# Template Syntax Reference

Read this when creating or revising slides in `模板.html`.

## Core Structure

Slides live inside:

```html
<div class="slide-area">
  <section class="slide gap-normal" data-section="适合：..." data-title="短标题">
    <div class="page-num">1/10</div>
    <div class="slidebar"><span>LAYOUT XX</span><span>页眉说明</span></div>
    <div class="body">...</div>
    <div class="layout-note"><b>版式注释：</b>... ｜ <b>使用建议：</b>...</div>
  </section>
</div>
```

Keep:

- `.slide` as the outer page.
- `.page-num` with the final page number and total.
- `data-title` for thumbnail labels.
- `data-section` for thumbnail context.
- `.body` as the main content container.
- `.layout-note` as template guidance unless producing a clean final deck.

Do not remove or rewrite the navigation, presenter-notes, sync, export, or scaler scripts while only creating slide content.

## Speaker Notes

Speaker notes are stored in two places:

- `speaker-notes.json`: used by the token-protected service control page.
- `<script id="speaker-notes-data" type="application/json">` in `模板.html`: used when `模板.html` is opened directly through `file://` or as a non-control local page.

When changing slide count or order, keep both stores in sync and use 1-based string keys:

```json
{
  "1": "What the speaker should say on slide 1.",
  "2": "What the speaker should say on slide 2."
}
```

After editing `speaker-notes.json`, run `npm run sync-notes` instead of manually editing the embedded JSON.

Local presenter mode and service control mode both use the reserved bottom speaker-notes layout, so slide content must remain readable above the notes drawer.

## Common Components

- Text lists: `.bullets`, `.smallbullets`.
- Two-column layouts: `.grid.two` plus optional `layout-cols-40-60`, `layout-cols-45-55`, `layout-cols-55-45`, `layout-cols-60-40`.
- Cards: `.card`, `.module`, `.step`, `.compareblock`.
- Framing blocks: `.question`, `.tagline`, `.hint`, `.warning`, `.take`, `.logicline`.
- Figures: `.fig`, `.fig--sm`, `.fig--md`, `.fig--lg`, `.fig--xl`, `.fig--full`, `.fig.has-image`.
- Process: `.flow`, `.flowbox`, `.arrow`, `.wideflow`, `.pipeline`.
- Comparison: `.compare`, `.minirow`, `.bigcompare`, `.tbl`.
- Structure: `.pyramid`, `.tree`, `.dualpath`, `.finalmodel`.
- Special layouts: `.kpi-row`, `.timeline`, `.matrix`, `.pesc`, `.case-card`, `.swot`, `.qa`, `.ref-list`, `.annotation-demo`.

## Export Component Markers

Server advanced export and editable-text export prefer explicit `data-export-component` markers over class-name guessing:

- `split`: layout container; recurse into children and do not export the container itself.
- `component`: atomic visual block; export using normal frame/text/image heuristics.
- `text`: force a text layer.
- `image`: force an image layer.
- `frame`: force a frame layer.
- `ignore`: ignore this element and its children.

When adding a new layout, mark outer grouping elements as `split` and cards, figures, callouts, KPI blocks, panels, and other movable units as `component`.

## Image Pattern

Prefer this pattern for real images:

```html
<div class="fig fig--xl has-image" data-caption="图注：说明图片来源或读图重点" data-export-component="component">
  <img class="figure-img" src="image-name.png" alt="简短图片说明" />
</div>
```

Rules:

- Use `figure-img` so the template preserves aspect ratio with `object-fit: contain`.
- Use `fig--xl` or `fig--full` for screenshots, charts, mechanisms, microscopy, maps, or anything the audience must inspect.
- Keep captions short.
- If a chart is unreadable at slide scale, create a second zoom/detail slide instead of shrinking text around it.
- Do not stretch images with fixed width and height unless preserving aspect ratio is guaranteed.

## Layout Selection

| Content need | Use |
|---|---|
| Title, speaker, unit, date | Cover slide |
| Deck structure | Table of contents |
| Section break | Divider slide |
| One key claim with support | LAYOUT 01 |
| Explain a figure, chart, screenshot, or result | LAYOUT 02 |
| Four parallel ideas | LAYOUT 03 |
| Sequence, process, method steps | LAYOUT 04 |
| Two-way comparison | LAYOUT 05 |
| Multi-metric comparison | LAYOUT 06 |
| Hierarchy, levels, priority | LAYOUT 07 |
| Classification or cause tree | LAYOUT 08 |
| Two paths leading to one conclusion | LAYOUT 09 |
| Research design or technical route | LAYOUT 10 |
| Large diagram with explanation path | LAYOUT 11 |
| Conclusion or chapter recap | LAYOUT 12 |
| Numerical highlights | LAYOUT 13 |
| Time-based story | LAYOUT 14 |
| Decision matrix | LAYOUT 15 |
| Problem-evidence-conclusion argument | LAYOUT 16 |
| Case, patient, persona, project example | LAYOUT 17 |
| SWOT or strategy analysis | LAYOUT 18 |
| Q&A / defense backup | LAYOUT 19 |
| References and sources | LAYOUT 20 |
| Annotated image | LAYOUT 21 |

## Density Limits

Use these as soft limits:

- H1: one line if possible, two lines maximum.
- Bullet lists: 3-5 bullets, each short.
- Four-card pages: each card gets a short heading and 1-2 compact sentences.
- Flow pages: 4-5 steps maximum.
- Tables: 4-5 rows maximum on normal slides; use `text-sm-slide` for compact tables.
- Timelines: 5 nodes maximum.
- Matrices: 3 x 3 content cells are ideal.

If content exceeds these limits, split the page.

## Visual QA Checklist

Inspect changed slides after editing:

- No overlap between slide content, `.slidebar`, `.page-num`, `.layout-note`, and fixed controls.
- No clipped text in cards, modules, tables, callouts, timeline cards, matrix cells, or flow boxes.
- No important image area hidden by captions, callouts, or decorative elements.
- Images are not stretched and remain large enough to understand.
- The main claim is visible within three seconds.
- If presenter notes are active, the slide area remains readable above the notes drawer.
- Export modes still work because each slide remains a fixed 1280 x 720 `.slide`.
- The export chooser still has four modes: pure frontend export plus three server exports.
- The server export modes are only enabled on `?role=control&token=...`.
- The default screenshot output remains 4K through scale 3.
- `npm test` passes after content, notes, or export-related changes.

If visual QA fails, prefer one of these fixes:

- Reduce text.
- Split into multiple slides.
- Switch to a roomier layout.
- Increase figure size and move explanation into notes.
- Replace a dense table with cards, a matrix, or a summary plus notes.

## Export Compatibility

- Pure frontend export runs in the browser and uses the bundled `html2canvas` and `pptxgen` libraries.
- Service normal export uses `export-pptx.js` and writes each slide as a full-slide PNG.
- Service advanced export uses `export-components.js` with `COMPONENT_EXPORT_MODE=advanced` and writes component screenshots.
- Service editable-text export uses `export-components.js` with `COMPONENT_EXPORT_MODE=editable` and writes eligible text as native PPT text boxes.
- Ordinary text should be allowed to wrap. Avoid CSS or generated markup that marks normal paragraphs as `white-space: nowrap` unless clipping is intentional.
