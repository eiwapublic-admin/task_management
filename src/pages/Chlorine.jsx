import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ChlorineForm from '../components/ChlorineForm'
import useChlorinePdfExport from '../hooks/useChlorinePdfExport'
import { IconChevronRight, IconDownload } from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import {
  CHLORINE_BUILDINGS,
  CHLORINE_STANDARD_MIN,
  fetchChlorineTests,
  deleteChlorineTest,
  formatConcentration,
  formatReportDate,
  currentMonthJST,
  shiftMonth,
} from '../lib/reports'
import './Dashboard.css'
// AttachmentPreview（PDFのアプリ内プレビュー）の見た目はタスク管理側の KanbanBoard.css で
// 定義されているため、この画面を直接開いた場合に備えて明示的に import しておく
// （Inspections.jsx / ReportList.jsx と同じ対応）。
import '../components/KanbanBoard.css'

// 残留塩素等検査（Phase 5。2026-08-10）。
// 現行アプリ（FileMaker）の「残留塩素濃度_TOP」「検査一覧」「帳票」に相当する画面を
// 1画面にまとめたもの。日を跨って一覧できるよう、違反車両一覧と同じく日報とは独立した
// 画面にし、各記録から当日の日報へ戻れるようにしている。
//
// 2026-08-13: 表示対象年・測定施設の絞り込みを廃止し、常に全件を年月でグループ表示する
// 構成に変更（実機フィードバック）。年月グループはトグルで開閉でき、今月・前月だけ既定で
// 開く。帳票PDFの出力は各グループ見出しの「↓」から起動する — 帳票そのものは「年単位・
// 施設別」の紙様式（`ChlorineSheet.jsx`）なので、どの月の「↓」を押しても、その月が属する
// "年"の年間分をまとめて出力する（対象施設だけをその場のダイアログで選ぶ）。
export default function Chlorine() {
  const user = getCurrentUser()
  const readOnly = user?.role === 'owner'

  const [tests, setTests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 入力モーダル。'new' なら新規、レコードなら編集
  const [editing, setEditing] = useState(null)
  // PDFダウンロードダイアログ。開いている間は対象年（グループの「↓」から渡される）を持つ
  const [pdfDialogYear, setPdfDialogYear] = useState(null)
  const [pdfBuilding, setPdfBuilding] = useState(CHLORINE_BUILDINGS[0])
  // 年月グループの開閉状態。ユーザーが手で切り替えた分だけ既定値からの例外として持つ
  const [collapseOverrides, setCollapseOverrides] = useState({})
  const pdf = useChlorinePdfExport()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setTests(await fetchChlorineTests())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 年月ごとにまとめる（新しい月が上）。行には測定日（YYYY-MM-DD）を持たせておく
  const groups = useMemo(() => {
    const map = new Map()
    for (const t of tests) {
      // 測定日はJSTの日付で見る（tested_at はタイムゾーン付きで持っている）
      const date = new Date(t.tested_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
      const yearMonth = date.slice(0, 7)
      if (!map.has(yearMonth)) map.set(yearMonth, [])
      map.get(yearMonth).push({ ...t, date })
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([yearMonth, rows]) => ({
        yearMonth,
        rows: rows.sort((a, b) => {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1
          return new Date(a.tested_at) - new Date(b.tested_at)
        }),
      }))
  }, [tests])

  // 前月・今月は既定で開き、それより古い月は既定で閉じる
  const previousMonth = useMemo(() => shiftMonth(currentMonthJST(), -1), [])
  function isGroupOpen(yearMonth) {
    const override = collapseOverrides[yearMonth]
    if (override !== undefined) return override
    return yearMonth >= previousMonth
  }
  function toggleGroup(yearMonth) {
    setCollapseOverrides((prev) => ({ ...prev, [yearMonth]: !isGroupOpen(yearMonth) }))
  }

  function handleSaved(saved) {
    setTests((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)])
    setEditing(null)
    // 測定日を変更した場合など、一覧の並び・グループが変わりうるので取り直す
    load()
  }

  async function handleDelete(id) {
    setTests((prev) => prev.filter((t) => t.id !== id))
    setEditing(null)
    try {
      await deleteChlorineTest(id)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  function handleConfirmPdf() {
    const year = pdfDialogYear
    setPdfDialogYear(null)
    pdf.download(year, pdfBuilding)
  }

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow reports-container">
        {/* 機能ヘッダ（2026-08-13）。ホームボタン・表示対象年/測定施設の絞り込みは廃止。
            右端に「＋」（測定を記録）だけを置く */}
        <FeatureHeader
          actions={
            !readOnly && (
              <button
                type="button"
                className="icon-btn-add"
                onClick={() => setEditing('new')}
                aria-label="測定を記録"
                title="測定を記録"
              >
                ＋
              </button>
            )
          }
        />

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {pdf.error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {pdf.error}
          </p>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : groups.length === 0 ? (
          <p className="settings-hint">まだ測定記録がありません。</p>
        ) : (
          <div className="chlorine-list">
            {groups.map((g) => {
              const open = isGroupOpen(g.yearMonth)
              return (
                <section className="chlorine-month" key={g.yearMonth}>
                  <div
                    className="chlorine-month-head"
                    onClick={() => toggleGroup(g.yearMonth)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleGroup(g.yearMonth)
                      }
                    }}
                  >
                    <IconChevronRight
                      size={18}
                      className={`chlorine-month-toggle-icon${open ? ' is-open' : ''}`}
                    />
                    <span className="chlorine-month-label">{g.yearMonth.replace('-', '年')}月</span>
                    <button
                      type="button"
                      className="icon-btn-download chlorine-month-pdf-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPdfDialogYear(Number(g.yearMonth.slice(0, 4)))
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label={`${g.yearMonth.slice(0, 4)}年の残留塩素等検査実施記録表をPDF出力`}
                      title={`${g.yearMonth.slice(0, 4)}年の残留塩素等検査実施記録表をPDF出力`}
                    >
                      <IconDownload size={18} />
                    </button>
                  </div>
                  {open && (
                    <ul className="chlorine-rows">
                      {g.rows.map((t) => {
                        const below =
                          t.concentration !== null &&
                          t.concentration !== undefined &&
                          Number(t.concentration) < CHLORINE_STANDARD_MIN
                        return (
                          <li key={t.id}>
                            <div
                              className={`chlorine-row${readOnly ? '' : ' is-clickable'}`}
                              onClick={readOnly ? undefined : () => setEditing(t)}
                              role={readOnly ? undefined : 'button'}
                              tabIndex={readOnly ? undefined : 0}
                              onKeyDown={
                                readOnly
                                  ? undefined
                                  : (e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault()
                                        setEditing(t)
                                      }
                                    }
                              }
                            >
                              <span className="chlorine-row-date">{formatReportDate(t.date)}</span>
                              <span className="chlorine-row-building">{t.building}</span>
                              <span className={`chlorine-row-value${below ? ' is-below' : ''}`}>
                                {formatConcentration(t.concentration) || '—'}
                              </span>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}

        <p className="settings-hint chlorine-legend">
          週1回検査／水道水質基準: 遊離残留塩素濃度として {CHLORINE_STANDARD_MIN.toFixed(1)}mg/L 以上
        </p>
      </div>

      {pdf.sheetsPortal}

      {editing && (
        <ChlorineForm
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          defaultBuilding={tests[0]?.building || CHLORINE_BUILDINGS[0]}
          defaultInspector={user?.display_name || ''}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}

      {/* 帳票の出力対象施設を選ぶダイアログ（2026-08-13。以前は機能ヘッダの常設ドロップダウンで
          選ばせていたが、その絞り込み欄自体を廃止したため、「↓」を押した時だけその場で選ぶ形にした） */}
      {pdfDialogYear !== null && (
        <div
          className="ui-overlay is-nested"
          role="dialog"
          aria-modal="true"
          onClick={() => setPdfDialogYear(null)}
        >
          <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
            <div className="ui-modal-head">
              <h3 className="ui-modal-title">PDFダウンロードする施設を選択して下さい</h3>
              <button
                type="button"
                className="icon-btn-close"
                onClick={() => setPdfDialogYear(null)}
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <div className="ui-modal-body is-stacked">
              <div className="chlorine-building-toggle" role="group" aria-label="測定施設">
                {CHLORINE_BUILDINGS.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`chlorine-building-btn${pdfBuilding === b ? ' is-active' : ''}`}
                    aria-pressed={pdfBuilding === b}
                    onClick={() => setPdfBuilding(b)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <div className="ui-modal-foot">
              <div className="ui-modal-foot-start" />
              <div className="ui-modal-foot-end">
                <button type="button" className="btn-plain" onClick={() => setPdfDialogYear(null)}>
                  キャンセル
                </button>
                <button type="button" className="btn-primary" onClick={handleConfirmPdf} disabled={pdf.busy}>
                  ダウンロード
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pdf.previewModal}
      {pdf.busyOverlay}
    </div>
  )
}
