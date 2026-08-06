---
name: print-and-pdf-download
description: Add "print this" and/or "download as PDF" to a React/Next.js page — both for a small static panel (poster, QR sheet, notice) and for a wide data table / multi-page report. Covers hard-won gotchas that look unrelated but recur: (1) iOS/iPadOS home-screen PWAs (standalone display-mode) cannot call window.print() at all — so on PWA-first apps @media print tuning is worthless and PDF download is the ONLY export that works, for tables too; (2) toggling a body class + @media print to show/hide a "print sheet" tends to produce a blank second printed page — print via a fresh isolated window.open() document instead; (3) forcing that sheet to exactly one page's physical size (height:297mm + @page{margin:0}) fights the OS print margin and spills onto a phantom second page; (4) html2canvas 1.x throws "Attempting to parse an unsupported color function oklch" on Tailwind v4 (whose default palette is oklch) — use the html2canvas-pro fork, but do NOT blanket-migrate working captures to it, as pro can break mm-based/custom-CSS layouts; (5) capturing an element that lives inside overflow-x:auto only captures the visible slice — re-render it off-screen at full width during capture; plus canvas slicing for multi-page PDFs, and never swallowing the capture error. Use whenever adding print/PDF export, when "print doesn't work on iPhone/iPad", when a PDF comes out blank/clipped/broken, or when print output shows an unexpected blank extra page.
---

# Print + PDF download (React/Next.js)

> **このプロジェクトでの注意（2026-08-06 導入）**: 他プロジェクトで作成したスキルをそのまま
> 移植したもの。`task_management` は Vite + React（Next.js ではない）で、CSS も自前の
> カスタムプロパティ（`--color-primary` 等）を使う手書きCSSであり **Tailwind は使っていない**
> ため、Gotcha 4/5 の `oklch`／Tailwind v4 まわりの罠はそのままでは発生しない（該当する場合は
> 通常の `html2canvas`（`-pro` ではない）を使えばよい）。`assets/*.tsx` もこのプロジェクトの
> 実コードは `.jsx`（型注釈なし）なので、そのまま貼り付けるのではなく実装の参考として読み、
> 型注釈を外して移植すること。現時点でこのアプリに印刷/PDFダウンロード機能は存在しない
> （導入時点では知見の登録のみで、具体的な画面への実装依頼はまだない）。

Two shapes of the same job:

- **A small static panel** — QR sheet, flyer, notice, single-page form → "The gotchas" below.
- **A wide data table / multi-page report** → same PDF machinery, different capture setup →
  ["Wide data tables"](#wide-data-tables--multi-page-reports).

**If the app is used as an installed PWA, treat PDF download as the primary export and
`window.print()` as the optional extra.** Gotcha 1 is not an edge case; on an iOS home-screen
app printing simply does not exist, so `@media print` tuning buys you nothing there — including
for tables, which is the opposite of what feels natural.

This grew out of several consecutive round-trips fixing the same features, each fix revealing
the next problem. Apply the gotchas up front instead of rediscovering them one at a time.

## The gotchas, in the order symptoms actually appear

### Gotcha 1 — `window.print()` is a no-op in iOS/iPadOS home-screen PWAs

If the app is added to the iOS/iPadOS home screen (`display-mode: standalone`), WebKit
**silently does nothing** when `window.print()` is called — no error, no dialog, the button just
looks dead. It works fine in a normal Safari tab. This is a platform limitation, not a bug in
your code — there is no CSS/JS workaround, only detection.

**Fix: detect it and hide the print button**, showing only the PDF-download button (which uses a
real file download, not `window.print()`, and works in standalone mode):

```ts
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
const isStandalone =
  (navigator as unknown as { standalone?: boolean }).standalone === true ||
  window.matchMedia("(display-mode: standalone)").matches;
const printSupported = !(isIOS && isStandalone);
```

Run this in a `useEffect` (it needs `navigator`/`window`, so it can't run at render time on the
server) and conditionally render the print button on `printSupported`.

### Gotcha 2 — "hide everything else, show the sheet, `window.print()`" produces a blank 2nd page

The common pattern for printing "just this one thing" out of a larger app page is: portal a
`.print-sheet` div to `document.body`, add a `body.print-mode` class, use `@media print { body.print-mode > *:not(.print-sheet) { display:none } }` to hide everything else, call
`window.print()`, then remove the class. **This is fragile** — depending on content size, other
elements the hide-rule doesn't quite reach (script tags, portals from other components, PWA
banners, framework-injected nodes), and browser/OS quirks, it can produce **a genuine blank
second printed page** even though visually only one page's content exists. This project hit that
bug, "fixed" it once, and had it resurface later from an unrelated change.

**Fix: don't print from the current document at all.** Open a brand-new, empty window and
`document.write()` a **complete, minimal, self-contained HTML document** into it — just the
title/content/styles needed, nothing else — then print *that* window:

```ts
const w = window.open("", "_blank");
if (!w) { alert("ポップアップがブロックされました。"); return; }
const doc = w.document;
doc.open();
doc.write(`<!DOCTYPE html><html>...(see assets/PrintablePanel.tsx)...</html>`);
doc.close();
w.onafterprint = () => w.close();
w.setTimeout(() => { w.focus(); w.print(); }, 200); // let data-URL images paint first
```

There is structurally nothing else in that document that could contribute to a stray page. This
is strictly more reliable than any amount of `display:none`/`@media print` scoping in the host
page, and it's less code.

### Gotcha 3 — forcing the sheet to *exactly* one page's physical size backfires

Once printing from an isolated document (or even inside a scoped sheet), the instinct is to make
the box match the paper exactly: `width:210mm; height:297mm;` plus `@page { margin: 0; }` to kill
default headers/footers. **This can itself cause the blank-second-page bug**: many browsers/OS
print pipelines apply their **own** minimum print margin regardless of `@page{margin:0}`
(especially iOS AirPrint), so a box sized to *literally fill the page* ends up slightly taller
than the actual printable area once that margin is subtracted — and the overflow spills onto a
second, otherwise-empty page.

**Fix: don't force full-page height.** Set only `@page { size: A4 portrait; }` (page size, no
margin override), give the content box a `width` (for layout/wrapping) but **no fixed
height/min-height**, and let it size to its natural content height. For a small
poster/QR-sheet/notice, natural content height is comfortably under one page regardless of
whatever margin the OS decides to reserve — so there's no overflow to spill in the first place.
The mental model: **don't try to fill the page exactly; make sure you clearly fit inside it.**

```css
@page { size: A4 portrait; }         /* size only — no margin:0 */
body { width: 210mm; padding: 14mm 12mm; }  /* no height / min-height */
```

### Gotcha 4 — `html2canvas` dies on Tailwind v4 colours (`oklch`)

**Symptom:** PDF download fails immediately with
`Attempting to parse an unsupported color function "oklch"` — or, if you swallowed the error,
just a generic "failed to create PDF".

**Cause:** Tailwind CSS **v4** emits its default palette (`gray-*`, `red-*`, `white`, …) as
`oklch()`. `html2canvas@1.4.1` (last release: 2022) cannot parse `oklch`/`lab`/`color-mix` and
throws on the first element that uses one. So on Tailwind v4, **any element styled with stock
Tailwind utility classes is uncapturable** with the original library.

**Fix:** use **`html2canvas-pro`** — an API-compatible maintained fork that supports modern
colour functions. Same call signature, so it's a one-line import swap.

```ts
import("html2canvas-pro")   // NOT "html2canvas", on Tailwind v4
```

> ⚠️ **The maddening part:** a hand-written sheet styled only with plain CSS (hex colours in a
> `.css` file) captures **fine** with the original `html2canvas`, because it never encounters an
> `oklch` value. So in one app "the QR PDF works but the report PDF fails" — which looks like a
> problem with the report, not with the library. Check *how the captured subtree is styled*
> before blaming the content.

### Gotcha 5 — don't blanket-migrate working captures to `html2canvas-pro`

Having found that `-pro` fixes Gotcha 4, the obvious next move is to migrate every capture to it
and drop the original. **Don't.** In this project that immediately broke a previously-working QR
sheet: under `-pro` v2 the sheet's stylesheet rules stopped applying — `display:flex` on the
QR row and `img { width: 55mm }` were ignored, so two side-by-side 55mm QR codes rendered as a
vertical stack at natural (huge) size. The payslip table captured perfectly with the same
library at the same time.

**Fix: choose the library per capture target, and leave working captures alone.**

| Captured subtree | Library |
| --- | --- |
| Styled with Tailwind v4 utilities (`oklch` present) | `html2canvas-pro` |
| Hand-written CSS, hex colours, `mm` units, flex/`aspect-ratio` layout | `html2canvas` (original) |

Both are dynamically `import()`ed inside their own click handlers, so shipping both costs
nothing on any page that doesn't export a PDF. Record *why* each site uses which — otherwise a
future "let's unify these" cleanup silently re-breaks it.

### Gotcha 6 — never swallow the capture error

```ts
} catch {
  setError("PDFの作成に失敗しました");   // ← tells you nothing; costs a deploy round-trip
}
```

Capture failures are almost always a *specific* parse/layout error (Gotcha 4 being the prime
example) and the message names the cause outright. On a device you can't debug remotely, the
message is the entire diagnosis. Always surface it:

```ts
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  setError(`PDFの作成に失敗しました(${detail})`);
}
```

## PDF download: html2canvas + jsPDF (no font embedding needed)

`jsPDF`'s built-in fonts (Helvetica/Times/Courier) don't support Japanese or most non-Latin
scripts — text drawn with `pdf.text()` directly would render as blank boxes unless you embed a
custom TTF (large asset, extra build complexity). **Avoid that entirely** by rasterizing the
already-styled DOM node with `html2canvas` (which uses the browser's own font stack via `<canvas>`
`fillText`, so whatever the OS renders on screen is what ends up in the image) and dropping that
single image into a one-page PDF with `jsPDF`:

```ts
const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
  import("html2canvas"),      // Tailwind v4 utilities in the subtree? → "html2canvas-pro" (Gotcha 4/5)
  import("jspdf"),
]);
const canvas = await html2canvas(sheetRef.current, { scale: 3, backgroundColor: "#ffffff" });
const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, 210, 297);
pdf.save("filename.pdf");
```

Notes:
- `pdf.addImage(...)` places one raster image at fixed (x, y, width, height) mm coordinates — it
  never auto-paginates on its own, so this is always exactly one page regardless of the source
  canvas's pixel aspect ratio (it gets scaled/stretched to fit the given box).
- The DOM node being captured must actually be in the document and laid out (not
  `display:none`) at capture time. Portal it to `document.body` and toggle a class that shows it
  **off-screen** (`position:fixed; left:-10000px;`) just before calling `html2canvas`, then hide
  it again after. Wait one or two `requestAnimationFrame`s after toggling the class before
  capturing, so the browser has actually applied the layout change.
- **This node can safely use `height:297mm; overflow:hidden;`** (unlike the print-window body in
  Gotcha 3) — there's no OS print-margin process involved here, `addImage`'s fixed target
  dimensions guarantee one page regardless of what the source canvas looks like.
- Both libraries are heavy (`jspdf` ~140KB gz, `html2canvas` ~50KB gz) — always `import()` them
  dynamically inside the click handler, never at module top level, so they don't bloat the initial
  page bundle. (This is also why shipping *both* `html2canvas` and `html2canvas-pro` for different
  capture targets, per Gotcha 5, costs nothing on pages that export neither.)

## Wide data tables / multi-page reports

If the users are on desktop browsers, prefer the cheap route: keep `window.print()` and tune
`@media print` on the real content (shrink font/padding, `overflow: visible`, let the print
engine paginate naturally). No canvas, no libraries.

**But if the app is used as an installed PWA, that route doesn't exist** (Gotcha 1) — the print
button is dead on iOS home-screen apps, so `@media print` rules are never exercised there. In
that case, drop the print button for tables too and give them the same html2canvas + jsPDF
treatment as a panel, with three differences:

**1. The table is inside an `overflow-x: auto` wrapper — capture would clip to the visible
slice.** You must re-render it at full width for the duration of the capture. Same off-screen
trick as a panel, plus un-scoping the scroll container:

```css
body.pdf-capture-mode .pdf-capture-target {
  position: fixed; top: 0; left: -10000px; z-index: -1;
  width: 1400px;          /* wide enough for every column; scaled down into the page later */
  max-width: none;
  background: #fff;
}
body.pdf-capture-mode .pdf-capture-target .scroll-wrapper { overflow: visible !important; }
/* sticky first columns fight the capture — neutralise them */
body.pdf-capture-mode .pdf-capture-target th,
body.pdf-capture-mode .pdf-capture-target td {
  position: static !important;
  box-shadow: none !important;
}
```

Add both classes in the handler and remove them in `finally` (**always `finally`** — leaving
`pdf-capture-mode` on after a throw hides the report from the live page).

**2. Landscape, and slice the canvas across pages.** `pdf.addImage()` never paginates; it
stretches the image into the box you give it. For a report you want real pages, so cut the
source canvas into page-height strips:

```ts
const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
const margin = 8, pageW = 297, pageH = 210;
const imgW = pageW - margin * 2;
const pxPerMm = canvas.width / imgW;              // scale factor of the capture
const sliceHpx = Math.floor((pageH - margin * 2) * pxPerMm);

for (let y = 0, first = true; y < canvas.height; first = false) {
  const h = Math.min(sliceHpx, canvas.height - y);
  const slice = document.createElement("canvas");
  slice.width = canvas.width; slice.height = h;
  const ctx = slice.getContext("2d")!;
  ctx.fillStyle = "#ffffff";                       // else transparent → black in the PDF
  ctx.fillRect(0, 0, slice.width, slice.height);
  ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
  if (!first) pdf.addPage();
  pdf.addImage(slice.toDataURL("image/png"), "PNG", margin, margin, imgW, h / pxPerMm);
  y += h;
}
```

(Slicing cuts at a fixed pixel offset, so a row can be split across the page break. Acceptable
for an internal report — but if the table has natural group boundaries (one block per employee,
per order, per day…), there's a cheap fix short of abandoning the single-canvas approach:
see "Keeping groups together across page breaks" below.)

### Keeping groups together across page breaks

Confirmed working in production (2026-08-05): a per-employee daily report went from routinely
splitting a person's rows across a page break to every group landing cleanly on its own page(s),
verified against a real generated PDF, not just the pagination math.

If splitting mid-row inside a group is a real complaint (not just cosmetic), don't move to
per-row pagination — instead make the *cut points* boundary-aware while keeping everything else
about the single-canvas approach unchanged. Mark each group's container with a shared class, and
measure where those containers land **in the DOM, right before the html2canvas call** — not
after, once it's a flat image there's no group information left to use:

```ts
const scale = 2;
const elRect = el.getBoundingClientRect();
// canvas-space Y of each group's top edge (scale factor converts DOM px → canvas px)
const groupBoundaries = Array.from(el.querySelectorAll(".pdf-group"))
  .map((g) => Math.round((g.getBoundingClientRect().top - elRect.top) * scale))
  .filter((v) => v > 0);                    // the very first group needs no cut before it

const canvas = await html2canvas(el, { scale, backgroundColor: "#ffffff", useCORS: true });
```

Then, in the pagination loop, prefer the nearest group boundary at or before where a mechanical
cut would land — and only fall back to the mechanical cut when no boundary fits (a single group
taller than one page; without this fallback you get an infinite loop or an empty page):

```ts
let y = 0, first = true;
while (y < canvas.height) {
  const desiredEnd = Math.min(y + sliceHpx, canvas.height);
  let end = desiredEnd;
  if (desiredEnd < canvas.height) {
    const candidates = groupBoundaries.filter((b) => b > y && b <= desiredEnd);
    if (candidates.length > 0) end = candidates[candidates.length - 1];
  }
  const h = end - y;
  /* ...same slice/addImage as above, using h instead of the old fixed slice height... */
  first = false;
  y = end;
}
```

This is a strict superset of the plain version: pass no group selector (or an empty match) and
it degenerates to exactly the old fixed-offset behavior, so it's safe to make this the default
signature of a shared PDF-download component rather than a special case. Verify with a quick
pure-function simulation (canvas height, slice height, boundary list → page ranges) before
trusting it on a real capture — it's cheap to check for infinite loops, non-contiguous ranges, or
a boundary that never gets used, and those bugs are hard to spot by eyeballing a generated PDF.

**3. The button lives far from the table.** With the trigger in a toolbar component and the
table in a page component, you can't pass a `ref`. Give the table a **stable `id`** and let the
button do `document.getElementById(...)`. Cross-reference the id in a comment on **both** sides —
it's an invisible coupling that a rename will silently break.

## Files in this skill

| File | Purpose |
| --- | --- |
| `assets/PrintablePanel.tsx` | **Small panel.** Print button (Gotcha 1 detection + Gotcha 2/3 isolated-window printing) + PDF button (html2canvas+jsPDF). Adapt the markup/styles to your panel. |
| `assets/capture-sheet.css` | Companion CSS for the panel's PDF-capture node (`.pdf-capture-sheet` / `body.pdf-capture-mode`). |
| `assets/TablePdfButton.tsx` | **Wide table.** PDF-only button: id-based target, off-screen full-width capture, landscape, canvas slicing across pages with optional group-boundary-aware cuts (`sectionSelector`), error surfaced (Gotchas 4/5/6). |
| `assets/table-capture.css` | Companion CSS for the table capture (`.pdf-capture-target`: off-screen width, releasing `overflow-x`, neutralising sticky columns). |

## Verify

`npm run build` must pass, but **a build proving nothing is the trap here** — every failure in
this skill is a runtime/rendering failure that only a real device shows. Open the generated PDF:

- **Panel:** exactly one page (not two, with the second blank); non-Latin text renders.
- **Table:** *every column* present (not clipped at the scroll edge — Gotcha 5's symptom), text
  legible after the scale-down, page breaks land somewhere sane.
- **After any library swap, re-open every PDF in the app**, not just the one you were fixing —
  that is exactly how the QR sheet got broken by a fix aimed at the report (Gotcha 5).
- On iOS check both a normal Safari tab (print works) and an installed home-screen icon (print
  button hidden; PDF download still works).
