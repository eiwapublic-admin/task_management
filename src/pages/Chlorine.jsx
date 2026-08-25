import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ChlorineForm from '../components/ChlorineForm'
import { ChlorineTrendChart } from '../components/ChlorineChart'
import useChlorinePdfExport from '../hooks/useChlorinePdfExport'
import { IconChevronRight, IconDownload } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import {
  CHLORINE_BUILDINGS,
  CHLORINE_STANDARD_MIN,
  fetchChlorineTests,
  deleteChlorineTest,
  formatConcentration,
  formatReportDate,
  currentMonthJST,
  shiftMonth,
  jstDateOnly,
  todayJST,
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
//
// 2026-08-13: 対象施設は1日にまとめて実施する運用のため、新規保存の直後に同じ日の
// 他施設がまだ未記録なら、閉じずにそのまま次の施設の入力へ続ける（handleSaved参照）。
// 「＋」を押した時点でも、その日まだ記録の無い施設を自動で選んでおく（pickBuildingFor）。
// 2026-08-25: 対象施設をBKB・小泉本社の2つから3施設目（当時の呼称「スイングビル」、
// 同日中に「旧本社」へ呼称変更）を加えた3つに変更したが、このロジック自体は
// CHLORINE_BUILDINGSの並び順に従って汎用的に動くため変更不要だった。

// 画面上部の推移グラフ（過去3年・3施設。2026-08-25新規）用の設定。
// 系列色はdataviz方針に沿い、カテゴリ順に固定の識別色を割り当てる（CHLORINE_BUILDINGS
// の並び順=BKB・小泉本社・旧本社に対応）。既存の単系列グラフで使っている
// --color-primaryを1つ目に据え、2・3つ目はスキルのカテゴリパレット（オレンジ・アクア）
// から採用し、validate_palette.jsで3色ともALL PASS（CVD隣接ΔE9.2・通常視ΔE27.6）を確認済み
const CHLORINE_TREND_MONTHS = 36
const CHLORINE_TREND_COLORS = ['var(--color-primary)', '#eb6834', '#1baf7a']

export default function Chlorine() {
  const user = getCurrentUser()
  // 残留塩素の書き込みは owner・備品出庫限定ロール（2026-08-25追加）どちらも不可
  const readOnly = isLimitedRole(user)

  const [tests, setTests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 入力モーダル。'new' なら新規、レコードなら編集
  const [editing, setEditing] = useState(null)
  // 新規登録時の対象施設。「＋」を押した時点、またはペア記録の続きを開く時点で決める
  // （下記 pickBuildingFor 参照。BKB・小泉本社は1日にペアで実施するため、片方を保存したら
  // もう片方が未記録ならその場で続けて開けるようにする。2026-08-13）
  const [newBuilding, setNewBuilding] = useState(CHLORINE_BUILDINGS[0])
  // ペア記録の続きを開いた時だけ出す案内文（通常の「＋」では空のまま）
  const [pairNotice, setPairNotice] = useState('')
  // PDFダウンロードダイアログ。開いている間は対象年月（グループの「↓」から渡される。
  // 帳票自体は年単位で出力するが、ヘッダの年月表示に使う。2026-08-14）を持つ
  const [pdfDialog, setPdfDialog] = useState(null) // { year, month } | null
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

  // 画面上部の推移グラフ用データ（過去3年・3施設。2026-08-25新規）。月ごとの平均濃度を
  // 施設別に算出する。その月に測定が無い施設はnull（グラフ側でその区間だけ線を切る）
  const chlorineTrendMonths = useMemo(() => {
    const cur = currentMonthJST()
    const out = []
    for (let i = CHLORINE_TREND_MONTHS - 1; i >= 0; i--) {
      const key = shiftMonth(cur, -i)
      const [y, m] = key.split('-')
      out.push({ key, shortLabel: `${y.slice(2)}/${Number(m)}`, fullLabel: `${y}年${Number(m)}月` })
    }
    return out
  }, [])

  const chlorineTrendSeries = useMemo(() => {
    const sums = new Map() // building -> Map(monthKey -> { sum, count })
    for (const t of tests) {
      if (t.concentration == null) continue
      const monthKey = jstDateOnly(t.tested_at).slice(0, 7)
      if (!sums.has(t.building)) sums.set(t.building, new Map())
      const byMonth = sums.get(t.building)
      const cur = byMonth.get(monthKey) || { sum: 0, count: 0 }
      cur.sum += Number(t.concentration)
      cur.count += 1
      byMonth.set(monthKey, cur)
    }
    return CHLORINE_BUILDINGS.map((building, i) => {
      const byMonth = sums.get(building) || new Map()
      const values = chlorineTrendMonths.map((mo) => {
        const rec = byMonth.get(mo.key)
        return rec ? rec.sum / rec.count : null
      })
      return { key: building, label: building, color: CHLORINE_TREND_COLORS[i], values }
    })
  }, [tests, chlorineTrendMonths])

  // 年月ごとにまとめる（新しい月が上）。さらに同じ月の中で測定日ごとにまとめ、
  // 1日分の記録（BKB・小泉本社）を1行に横並びのカードで表示する（2026-08-19。
  // 以前は施設ごとに別の行だったが、同じ日の2施設を1行で見渡せるようにした）
  const groups = useMemo(() => {
    const map = new Map()
    for (const t of tests) {
      // 測定日はJSTの日付で見る（tested_at はタイムゾーン付きで持っている）
      const date = new Date(t.tested_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
      const yearMonth = date.slice(0, 7)
      if (!map.has(yearMonth)) map.set(yearMonth, new Map())
      const dateMap = map.get(yearMonth)
      if (!dateMap.has(date)) dateMap.set(date, [])
      dateMap.get(date).push({ ...t, date })
    }
    return [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([yearMonth, dateMap]) => ({
        yearMonth,
        dates: [...dateMap.entries()]
          .sort((a, b) => (a[0] < b[0] ? 1 : -1))
          .map(([date, list]) => ({
            date,
            tests: list.sort(
              (a, b) => CHLORINE_BUILDINGS.indexOf(a.building) - CHLORINE_BUILDINGS.indexOf(b.building)
            ),
          })),
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

  // 指定日（JST）に測定済みの施設の集合。ペア記録の判定に使う
  function buildingsRecordedOn(date, list) {
    const set = new Set()
    for (const t of list) {
      const d = new Date(t.tested_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
      if (d === date) set.add(t.building)
    }
    return set
  }

  // その日まだ記録の無い施設を返す（両方記録済み・両方未記録ならBKBを優先）
  function pickBuildingFor(date, list) {
    const recorded = buildingsRecordedOn(date, list)
    return CHLORINE_BUILDINGS.find((b) => !recorded.has(b)) || CHLORINE_BUILDINGS[0]
  }

  function handleSaved(saved) {
    const wasNew = editing === 'new'
    const nextTests = [saved, ...tests.filter((t) => t.id !== saved.id)]
    setTests(nextTests)
    // 測定日を変更した場合など、一覧の並び・グループが変わりうるので取り直す
    load()

    // 新規保存の直後は、同じ日にまだ未記録の施設があれば続けて開く（CHLORINE_BUILDINGSの
    // 並び順で次に見つかった1件。3施設に増えた後も、全施設分記録し終えるまで順に案内する。
    // 2026-08-13導入・2026-08-25にスイングビル追加へ対応。既存レコードの編集時は対象外）
    if (wasNew) {
      const savedDate = new Date(saved.tested_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
      const recorded = buildingsRecordedOn(savedDate, nextTests)
      const nextBuilding = CHLORINE_BUILDINGS.find((b) => !recorded.has(b))
      if (nextBuilding) {
        setNewBuilding(nextBuilding)
        setPairNotice(`${saved.building}を記録しました。続けて${nextBuilding}も記録してください。`)
        setEditing('new')
        return
      }
    }
    setPairNotice('')
    setEditing(null)
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
    const { year, month } = pdfDialog
    setPdfDialog(null)
    pdf.download(year, pdfBuilding, month)
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
                onClick={() => {
                  setPairNotice('')
                  setNewBuilding(pickBuildingFor(todayJST(), tests))
                  setEditing('new')
                }}
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

        {/* 画面上部の推移グラフ（過去3年・3施設。2026-08-25新規）。記録が無いうちは
            出しても意味がないため、1件以上あるときだけ表示する */}
        {!loading && tests.length > 0 && (
          <div className="ui-card chlorine-trend-card">
            <div className="ui-card-title">残留塩素濃度の推移（過去3年）</div>
            <ChlorineTrendChart
              months={chlorineTrendMonths}
              series={chlorineTrendSeries}
              standardValue={CHLORINE_STANDARD_MIN}
            />
          </div>
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
                        setPdfDialog({
                          year: Number(g.yearMonth.slice(0, 4)),
                          month: Number(g.yearMonth.slice(5, 7)),
                        })
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
                      {g.dates.map((d) => (
                        <li key={d.date}>
                          <div className="chlorine-row">
                            <span className="chlorine-row-date">{formatReportDate(d.date)}</span>
                            <div className="chlorine-row-buildings">
                              {d.tests.map((t) => {
                                const below =
                                  t.concentration !== null &&
                                  t.concentration !== undefined &&
                                  Number(t.concentration) < CHLORINE_STANDARD_MIN
                                return (
                                  <button
                                    key={t.id}
                                    type="button"
                                    className="chlorine-building-card"
                                    disabled={readOnly}
                                    onClick={() => setEditing(t)}
                                  >
                                    <span className="chlorine-building-card-name">{t.building}</span>
                                    <span className={`chlorine-building-card-value${below ? ' is-below' : ''}`}>
                                      {formatConcentration(t.concentration) || '—'}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        </li>
                      ))}
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
          key={editing === 'new' ? `new-${newBuilding}` : editing.id}
          existing={editing === 'new' ? null : editing}
          defaultBuilding={editing === 'new' ? newBuilding : undefined}
          defaultInspector={user?.display_name || ''}
          noticeMessage={editing === 'new' ? pairNotice : ''}
          onClose={() => {
            setPairNotice('')
            setEditing(null)
          }}
          onSaved={handleSaved}
          onDelete={handleDelete}
        />
      )}

      {/* 帳票の出力対象施設を選ぶダイアログ（2026-08-13。以前は機能ヘッダの常設ドロップダウンで
          選ばせていたが、その絞り込み欄自体を廃止したため、「↓」を押した時だけその場で選ぶ形にした） */}
      {pdfDialog !== null && (
        <div
          className="ui-overlay is-nested"
          role="dialog"
          aria-modal="true"
          onClick={() => setPdfDialog(null)}
        >
          <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
            <div className="ui-modal-head">
              <h3 className="ui-modal-title">PDFダウンロードする施設を選択して下さい</h3>
              <button
                type="button"
                className="icon-btn-close"
                onClick={() => setPdfDialog(null)}
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
                <button type="button" className="btn-plain" onClick={() => setPdfDialog(null)}>
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
