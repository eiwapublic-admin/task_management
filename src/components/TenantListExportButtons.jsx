import { useState } from 'react'
import { IconDocument, IconDownload, IconList, IconShare } from './Icons'
import SecureShareModal from './SecureShareModal'
import SecureShareListModal from './SecureShareListModal'
import { TENANT_LIST_KINDS, exportTenantList } from '../lib/tenantListExport'
import { TENANT_PDF_KINDS, defaultAsOf, defaultUpdateSince, parseSinceDate, printTenantListPdf } from '../lib/tenantListPdf'

// テナント一覧表（Excel）の出力ボタン（2026-10-21〜。社員だけ。基本情報を含むため。緊急連絡先は隠した列グループに入る）と、
// テナント一覧表・緊急連絡先一覧表の印刷用 PDF のボタン（2026-10-21〜。ブラウザの印刷で「PDFに保存」）と、
// 同じ PDF を期限付き・パスコード付きのリンクで渡す「安全なリンクで共有」（2026-10-26〜）
export default function TenantListExportButtons({ onError }) {
  const [busy, setBusy] = useState(null)
  const [shareModal, setShareModal] = useState(null)

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

  function printPdf(kind) {
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
    run(`pdf-${kind}`, () => printTenantListPdf(kind, { since, asOf }))
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
          onClick={() => printPdf(kind)}
          disabled={busy != null}
          title={`${def.label}（印刷用 PDF）を出力。印刷の画面で「PDFに保存」を選ぶ`}
        >
          <IconDocument size={20} />
          <span className="btn-plain-label">{busy === `pdf-${kind}` ? '作成中…' : `${def.label}（PDF）`}</span>
        </button>
      ))}
      <button
        type="button"
        className="btn-plain"
        onClick={() => setShareModal('create')}
        disabled={busy != null}
        title="PDF をメールに添付せず、期限付き・パスコード付きのリンクで渡す"
      >
        <IconShare size={20} />
        <span className="btn-plain-label">安全なリンクで共有</span>
      </button>
      <button
        type="button"
        className="btn-plain"
        onClick={() => setShareModal('list')}
        disabled={busy != null}
        title="作った共有リンクの状態・開かれた記録を見る。取り消し・パスコードの再発行"
      >
        <IconList size={20} />
        <span className="btn-plain-label">共有リンクの一覧</span>
      </button>
      {shareModal === 'create' && <SecureShareModal onClose={() => setShareModal(null)} />}
      {shareModal === 'list' && <SecureShareListModal onClose={() => setShareModal(null)} />}
    </>
  )
}
