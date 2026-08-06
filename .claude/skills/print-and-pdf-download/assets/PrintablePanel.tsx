"use client";

/**
 * Reference implementation: a "print this content" + "download as PDF" pair for a small,
 * mostly-static panel (a poster/flyer, a QR code sheet, a single-page notice — NOT a large
 * data table; see SKILL.md for that case).
 *
 * Adapt the `buildHtml()` markup/styles and the `sheetRef` content to your own panel.
 * Everything else (the print-window mechanism, the html2canvas+jsPDF mechanism, the iOS
 * standalone detection) is meant to be copied as-is.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function PrintablePanel({
  title,
  bodyHtml,
}: {
  title: string;
  /** Inner HTML of the printable sheet (already escaped by the caller if it embeds user data) */
  bodyHtml: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [printSupported, setPrintSupported] = useState(true);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
    // iOS/iPadOS home-screen (PWA standalone) apps cannot call window.print() at all.
    // Detect it and hide the print button rather than offering a button that silently
    // does nothing (see "Gotcha 1" in SKILL.md).
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS reports as Mac
    const isStandalone =
      (navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    setPrintSupported(!(isIOS && isStandalone));
  }, []);

  /**
   * Print via a fresh, isolated `window.open()` document — NOT via a hidden/shown sheet in
   * the current page toggled with a body class + `@media print`. See "Gotcha 2" in SKILL.md
   * for why the latter tends to produce a blank second page.
   */
  const handlePrint = () => {
    if (typeof window === "undefined") return;
    const w = window.open("", "_blank");
    if (!w) {
      alert("ポップアップがブロックされました。ブラウザの設定を確認してください。");
      return;
    }
    const doc = w.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  /* Set only the page SIZE. Do not set @page margin:0 and do not force the body to a
     full-page height (height:297mm / min-height:297mm). Let the OS/browser apply its own
     print margin and let the body size to its natural (comfortably-under-one-page) content
     height. Forcing an exact full-page box is what produced the blank second page — see
     "Gotcha 3" in SKILL.md. */
  @page { size: A4 portrait; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 210mm;
    padding: 14mm 12mm;
    text-align: center;
    font-family: "Hiragino Kaku Gothic ProN","Hiragino Sans","BIZ UDPGothic",Meiryo,system-ui,sans-serif;
  }
</style>
</head>
<body>${bodyHtml}</body>
</html>`);
    doc.close();
    w.onafterprint = () => w.close();
    // Give data-URL images (QR codes, logos, etc.) a moment to paint before printing.
    w.setTimeout(() => {
      w.focus();
      w.print();
    }, 200);
  };

  /**
   * Download the SAME panel as a PDF, for platforms where print() genuinely cannot run
   * (iOS/iPadOS standalone PWAs). html2canvas rasterizes the on-page DOM node (so Japanese/
   * any-script text renders correctly via the browser's own font stack — no font embedding
   * needed in the PDF library), then jsPDF drops that single image onto one page.
   */
  const handleDownloadPdf = async () => {
    if (typeof document === "undefined" || !sheetRef.current) return;
    setPdfBusy(true);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);

      document.body.classList.add("pdf-capture-mode");
      // Let layout settle before capturing.
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );

      const canvas = await html2canvas(sheetRef.current, {
        scale: 3,
        backgroundColor: "#ffffff",
        useCORS: true,
      });

      const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
      const imgData = canvas.toDataURL("image/png");
      // Fixed width/height matching the PDF page size — addImage does not paginate;
      // it just places one raster image, so this is always exactly one page.
      pdf.addImage(imgData, "PNG", 0, 0, 210, 297);
      pdf.save(`${title}.pdf`);
    } catch {
      alert("PDFの作成に失敗しました。時間をおいて再度お試しください。");
    } finally {
      document.body.classList.remove("pdf-capture-mode");
      setPdfBusy(false);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        {printSupported && (
          <button type="button" onClick={handlePrint}>
            印刷
          </button>
        )}
        <button type="button" onClick={handleDownloadPdf} disabled={pdfBusy}>
          {pdfBusy ? "作成中..." : "PDFダウンロード"}
        </button>
      </div>

      {/* The PDF-capture source node. Hidden on screen; only shown (off-screen) while
          html2canvas captures it. Portaled to <body> so it isn't affected by any parent
          layout (flex/grid containers, overflow:hidden, etc.). */}
      {mounted &&
        createPortal(
          <div
            ref={sheetRef}
            className="pdf-capture-sheet"
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />,
          document.body
        )}
    </div>
  );
}
