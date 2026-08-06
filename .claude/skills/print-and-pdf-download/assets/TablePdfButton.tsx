"use client";

/**
 * Reference implementation: "download this wide data table as a PDF".
 *
 * Use this (not PrintablePanel.tsx) when the thing being exported is a report table that
 * (a) lives inside an `overflow-x: auto` wrapper, and (b) may be taller than one page.
 *
 * Pairs with `table-capture.css`.
 *
 * Why PDF and not window.print(): on an installed iOS/iPadOS PWA `window.print()` silently
 * does nothing, so `@media print` rules are never exercised there. See SKILL.md Gotcha 1.
 */

import { useState } from "react";

export function TablePdfButton({
  /**
   * id of the element to capture (the card/section that wraps the table).
   * Cross-reference this id in a comment at the markup side too — it is an invisible
   * coupling and a rename will silently break the export.
   */
  targetId,
  filename,
  label = "PDF",
  /**
   * CSS selector (relative to the captured element) for group containers that must not
   * be split across a page break — e.g. one `<section>` per person/order/day in a report
   * with repeated blocks. When a mechanical page-height cut would land inside a group,
   * the cut is pulled back to that group's start instead. Omit for the plain fixed-offset
   * behavior (a row can then be split across pages — fine for a flat table with no groups).
   * See SKILL.md "Keeping groups together across page breaks".
   */
  sectionSelector,
}: {
  targetId: string;
  filename: string;
  label?: string;
  sectionSelector?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const el = document.getElementById(targetId);
    if (!el) {
      setError("出力対象が見つかりません");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // ⚠️ On Tailwind v4 this MUST be "html2canvas-pro": the stock palette is emitted as
      // oklch() and html2canvas@1.x throws "unsupported color function". Conversely, do NOT
      // switch a *working* hand-written-CSS capture (mm units, flex) over to -pro — it can
      // silently drop those rules. Pick per target. See SKILL.md Gotcha 4 + 5.
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas-pro"),
        import("jspdf"),
      ]);

      // Render off-screen at full width so the capture isn't clipped to the visible
      // slice of the horizontal scroll container.
      el.classList.add("pdf-capture-target");
      document.body.classList.add("pdf-capture-mode");
      try {
        // Let the browser actually apply the layout change before capturing.
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );

        const scale = 2;

        // Measure group boundaries in DOM space *before* html2canvas runs — once it's a
        // flat canvas there is no group information left to use. Must be measured here,
        // after the off-screen full-width layout has settled (the RAF wait above), so the
        // coordinates match what the capture actually sees.
        let sectionBoundaries: number[] = [];
        if (sectionSelector) {
          const elRect = el.getBoundingClientRect();
          sectionBoundaries = Array.from(el.querySelectorAll(sectionSelector))
            .map((s) =>
              Math.round((s.getBoundingClientRect().top - elRect.top) * scale)
            )
            .filter((v) => v > 0); // the first group needs no cut before it
        }

        const canvas = await html2canvas(el, {
          scale,
          backgroundColor: "#ffffff",
          useCORS: true,
        });

        // Landscape: a report table has far more columns than rows-per-page.
        const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" });
        const margin = 8;
        const pageW = 297;
        const pageH = 210;
        const imgW = pageW - margin * 2;
        const pxPerMm = canvas.width / imgW;
        const sliceHpx = Math.floor((pageH - margin * 2) * pxPerMm);

        // addImage() never paginates on its own — slice the canvas into page-height strips.
        // Prefer cutting at a group boundary within reach of the mechanical cut point;
        // fall back to the mechanical cut when no boundary fits (a single group taller
        // than one page) so this can never infinite-loop or skip content.
        let y = 0;
        let firstPage = true;
        while (y < canvas.height) {
          const desiredEnd = Math.min(y + sliceHpx, canvas.height);
          let end = desiredEnd;
          if (desiredEnd < canvas.height) {
            const candidates = sectionBoundaries.filter(
              (b) => b > y && b <= desiredEnd
            );
            if (candidates.length > 0) end = candidates[candidates.length - 1];
          }
          const h = end - y;
          const slice = document.createElement("canvas");
          slice.width = canvas.width;
          slice.height = h;
          const ctx = slice.getContext("2d");
          if (!ctx) throw new Error("canvas context を取得できませんでした");
          // Without this the untouched area is transparent, which prints black.
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, slice.width, slice.height);
          ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);

          if (!firstPage) pdf.addPage();
          pdf.addImage(
            slice.toDataURL("image/png"),
            "PNG",
            margin,
            margin,
            imgW,
            h / pxPerMm
          );
          firstPage = false;
          y = end;
        }
        pdf.save(filename);
      } finally {
        // MUST be in finally: if a throw leaves pdf-capture-mode on, the report
        // stays parked off-screen and vanishes from the live page.
        document.body.classList.remove("pdf-capture-mode");
        el.classList.remove("pdf-capture-target");
      }
    } catch (e) {
      // Never swallow this: the message names the real cause (e.g. the oklch parse error),
      // and on a user's phone it is the only diagnosis you will ever get. SKILL.md Gotcha 6.
      const detail = e instanceof Error ? e.message : String(e);
      setError(`PDFの作成に失敗しました(${detail})`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={run}
        aria-label="PDFダウンロード"
        title="PDFダウンロード"
        className="inline-flex h-10 items-center justify-center rounded-lg border border-blue-300 bg-white px-3 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
      >
        {busy ? "作成中..." : label}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
