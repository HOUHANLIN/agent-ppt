---
name: agent-ppt
description: Create or revise slide decks using this project's HTML PPT template. Use when Codex needs to turn a user outline, source content, paper notes, lesson plan, report, speech draft, or topic into `模板.html` slides; choose template layouts, write slide HTML, maintain `speaker-notes.json`, and perform visual QA for overlap, overflow, image sizing, readability, and PPTX export compatibility.
---

# Agent PPT

Use this skill to build content decks inside this project by editing the existing HTML PPT template. The goal is a clear, speakable slide deck, not a new presentation framework.

## Start Here

1. Read the user's source content and infer the presentation goal, audience, desired length, section structure, and tone.
2. Inspect `模板.html` before editing. Reuse its existing slide sections, CSS classes, controls, notes, sync, and export scripts.
3. Read `references/template-syntax.md` when choosing layouts, writing slide HTML, adding images, or doing visual QA.
4. Create a slide plan before editing: each slide gets one purpose, a chosen layout, a short title, and speaker-note intent.
5. Edit only the slide content and `speaker-notes.json` unless the user explicitly asks for template behavior changes.

## Deck Workflow

### 1. Convert content into a slide plan

- Put one main idea on each slide.
- Use cover, table of contents, and section divider slides when the deck has multiple sections.
- Prefer 8-15 slides for ordinary outlines unless the user requests a different length.
- Convert dense paragraphs into short claims, evidence, examples, and takeaways.
- Keep detail in `speaker-notes.json`; keep slides visually scannable.

### 2. Choose layouts by content type

Use the template's existing layouts instead of inventing new structures:

- **Title and framing**: cover, table of contents, section divider.
- **Core claim**: LAYOUT 01.
- **Image, chart, screenshot, figure, mechanism**: LAYOUT 02, LAYOUT 11, or LAYOUT 21.
- **Parallel points**: LAYOUT 03.
- **Process or sequence**: LAYOUT 04 or LAYOUT 14.
- **Two-side comparison**: LAYOUT 05.
- **Many objects or dimensions**: LAYOUT 06 or LAYOUT 15.
- **Hierarchy or priority**: LAYOUT 07.
- **Classification or cause breakdown**: LAYOUT 08.
- **Two evidence paths converging**: LAYOUT 09.
- **Experiment, project plan, technical route**: LAYOUT 10.
- **Summary or final takeaway**: LAYOUT 12 or LAYOUT 13.
- **Argument structure**: LAYOUT 16.
- **Case or persona**: LAYOUT 17.
- **Strategy analysis**: LAYOUT 18.
- **Q&A or backup**: LAYOUT 19.
- **References**: LAYOUT 20.

### 3. Write HTML in the template style

- Preserve `.slide-area`, navigation controls, presenter notes drawer, sync scripts, and export scripts.
- Each page must be a `<section class="slide ...">` with `data-title`, `data-section`, `.page-num`, and appropriate inner template structure.
- Keep `.layout-note` for template guidance unless the user asks for a clean audience deck without layout notes.
- Update every `.page-num` and the visible total after adding/removing slides.
- Keep `data-title` concise; it drives thumbnails.

### 4. Maintain speaker notes

- Update `speaker-notes.json` after slide changes.
- Use 1-based string keys: `"1"`, `"2"`, `"3"`.
- Notes should tell the speaker what to say, not repeat slide text verbatim.
- If a slide is a figure, note the intended reading order.
- If a slide is dense by necessity, move extra explanation into notes.

## Visual QA Is Mandatory

After editing slides, inspect the deck in a browser or with screenshots. Fix issues before finishing.

Check every changed slide for:

- Components overlapping each other, the slidebar, page number, layout note, navigation, or speaker-note reserved area.
- Text overflowing its box, table cells, cards, flow boxes, callouts, or the slide boundary.
- Titles wrapping awkwardly or pushing content downward.
- Cards, modules, timelines, matrices, and tables becoming too dense to read.
- Images stretched, cropped, too small, blurry, or crowding nearby text.
- Image-heavy slides where captions or callouts obscure the important region.

When a slide is too full, split it into multiple slides. Do not solve density by making text tiny or forcing content into a component.

For image slides:

- Preserve aspect ratio with the template image classes.
- Use larger figure layouts for important screenshots, charts, microscopy, maps, or diagrams.
- Replace unreadable images with a simpler crop, larger placement, or a separate zoom/detail slide.
- If the image is only decorative, keep it secondary and avoid stealing space from the message.

## Final Checks

Before reporting completion:

- Confirm slide count and page numbers match.
- Confirm `speaker-notes.json` keys cover the final slide count or intentionally omit only slides with no notes.
- Confirm control/audience/export scripts were not accidentally removed.
- Confirm the deck opens locally through `server.js` when notes or export behavior matters.
- Mention any visual QA that could not be performed.
