import { useState } from 'react'
import { IconDocument, IconDownload, IconShare } from './Icons'
import AttachmentPreview from './AttachmentPreview'
import PdfPreviewActions from './PdfPreviewActions'
import PdfBusyOverlay from './PdfBusyOverlay'
import SecureShareModal from './SecureShareModal'
import './SecureShare.css'
import { TENANT_LIST_KINDS, exportTenantList } from '../lib/tenantListExport'
import { TENANT_PDF_KINDS, buildTenantListPdfFile, defaultAsOf, defaultUpdateSince, parseSinceDate } from '../lib/tenantListPdf'
import { getReportPdfPreviewUrl } from '../lib/reports'

// テナント一覧表（Excel）の出力ボタン（2026-10-21〜。社員だけ。基本情報を含むため。緊急連絡先は隠した列グループに入る）と、
// テナント一覧表・緊急連絡先一覧表の PDF のボタン（2026-10-21〜）。
// 2026-10-29〜 PDF はビルメンの日程表と同じく、作った PDF をアプリ内のプレビュー画面に出す（従来はブラウザの印刷を直接開いていた）。
// 「安全なリンクで共有」（2026-10-26〜）はプレビュー画面のヘッダに移し、見ている PDF をそのまま共有する。
// 「共有リンクの一覧」はハンバーガーメニュー（AppHeader）へ移した
export default function TenantListExportButtons({ onError }) {
  const [busy, setBusy] = useState(null)
  const [preview, setPreview] = useState(null) // { kind, since, asOf, blob, filename, url }
  const [sharing, setSharing] = useState(false)

  async function run(key, fn) {
    setBusy(key)
    onError?.('')
    try {
      await fn()
    } catch (err) {
      onError?.(err.message)
    } finally {
      setBusy(null)
    }
  }

  // 日付を聞く（キャンセルなら null、読めなければエラーを出して null）
  function askDate(message, def) {
    const input = window.prompt(message, def.replaceAll('-', '/'))
    if (input == null) return null
    const date = parseSinceDate(input)
    if (!date) onError?.('日付が読み取れませんでした。2026/10/01 のように入力してください')
    return date
  }

  // テナント一覧表の時点の日付（既定は今月の1日。2026-10-26〜）
  const askAsOf = () =>
    askDate('時点の日付を入力してください（例: 2026/10/01）。この日に退去済みのテナントは載せません', defaultAsOf())

  function exportExcel(kind) {
    const asOf = askAsOf()
    if (!asOf) return
    run(kind, () => exportTenantList(kind, { asOf }))
  }

  function previewPdf(kind) {
    let since = ''
    let asOf = ''
    if (kind === 'emergency') {
      // 更新情報に載せる変更履歴の起点を聞く
      since = askDate(
        '更新情報に載せる変更の起点の日付を入力してください（例: 2026/10/01）。この日以降のテナントマスタの変更を載せ、この日の時点で退去日を迎えていないテナント（その後に退去した・退去予定）も載せます',
        defaultUpdateSince(),
      )
      if (!since) return
    } else {
      asOf = askAsOf()
      if (!asOf) return
    }
    run(`pdf-${kind}`, async () => {
      const file = await buildTenantListPdfFile(kind, { since, asOf })
      const url = await getReportPdfPreviewUrl(file.blob, file.filename, 'tenant-list')
      setPreview({ kind, since, asOf, blob: file.blob, filename: file.filename, url })
    })
  }

  return (
    <>
      {Object.entries(TENANT_LIST_KINDS).map(([kind, def]) => (
        <button
          key={kind}
          type="button"
          className="btn-plain"
          onClick={() => exportExcel(kind)}
          disabled={busy != null}
          title={`${def.label}（Excel）を出力`}
        >
          <IconDownload size={20} />
          <span className="btn-plain-label">{busy === kind ? '作成中…' : `${def.label}（Excel）`}</span>
        </button>
      ))}
      {Object.entries(TENANT_PDF_KINDS).map(([kind, def]) => (
        <button
          key={`pdf-${kind}`}
          type="button"
          className="btn-plain"
          onClick={() => previewPdf(kind)}
          disabled={busy != null}
          title={`${def.label}（PDF）を作ってプレビューする。プレビューから印刷・ダウンロード・安全なリンクで共有ができる`}
        >
          <IconDocument size={20} />
          <span className="btn-plain-label">{busy === `pdf-${kind}` ? '作成中…' : `${def.label}（PDF）`}</span>
        </button>
      ))}
      <PdfBusyOverlay show={busy != null && busy.startsWith('pdf-')} />
      {preview && (
        <AttachmentPreview
          attachment={{ filename: preview.filename, mimeType: 'application/pdf' }}
          url={preview.url}
          onClose={() => setPreview(null)}
          headerAction={
            <>
              <button
                type="button"
                className="attachment-preview-share-link"
                onClick={() => setSharing(true)}
                title="この PDF をメールに添付せず、期限付き・パスコード付きのリンクで渡す"
              >
                <IconShare size={16} />
                <span>安全なリンクで共有</span>
              </button>
              <PdfPreviewActions blob={preview.blob} filename={preview.filename} />
            </>
          }
        />
      )}
      {sharing && preview && (
        <SecureShareModal
          preset={{ kind: preview.kind, since: preview.since, asOf: preview.asOf, blob: preview.blob, filename: preview.filename }}
          onClose={() => setSharing(false)}
        />
      )}
    </>
  )
}
