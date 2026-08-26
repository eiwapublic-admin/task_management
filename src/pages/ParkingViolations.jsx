import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import ReportParkingViolations from '../components/ReportParkingViolations'
import ParkingViolationDetail from '../components/ParkingViolationDetail'
import { MonthlyTrendChart, RankingBarList } from '../components/ParkingCharts'
import { IconSearch, IconChevronRight } from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import {
  fetchParkingViolations,
  deleteParkingViolation,
  createReport,
  todayJST,
  VIOLATION_LABELS,
  formatReportDate,
  jstDateOnly,
} from '../lib/reports'
import './Dashboard.css'

// 同一ナンバー（地域+番号）の名寄せキー。どちらも未入力なら集計対象外にする
function plateKey(v) {
  if (!v.plate_region && !v.plate_number) return null
  return `${v.plate_region || ''}|${v.plate_number || ''}`
}

// checked_at（タイムスタンプ）からJSTの日付だけを取り出す処理は、ダッシュボードでも
// 使うため src/lib/reports.js の jstDateOnly() へ共通化した（2026-08-12）。
// 日付見出しは日付だけで十分＋時刻は目立たせたい項目の邪魔になるため時刻は出さない（2026-08-11）。

// ===== ダッシュボード（月別推移・テナント別/車別ランキング）＆ 年月グルーピング用
// ヘルパー（2026-08-25新規）=====

// 「所有会社・訪問先」欄が実質未記入とみなせる値。ここに当たらなければ
// テナントが判明しているものとして扱う（一度でも紐づいた車の名寄せに使う）
function isUnclearTenant(name) {
  if (!name) return true
  const t = name.trim()
  if (!t) return true
  if (t.includes('不明')) return true
  if (t.includes('外部')) return true
  if (/^\d+\s*[FfＦ階]$/.test(t)) return true // 「5F」「2階」等、階数だけの記載はテナント名ではない
  return false
}

// 車（地域+ナンバー）ごとに、一度でも判明したテナント名があればそれを紐付けとして
// 保持する（同じ車で「不明」の回とテナント判明済みの回が混在するケースがあるため。
// 複数のテナント名が記録されている車は、より多く記録されている方＝同点なら直近の
// ものを採用する）
function resolveTenantsByPlate(violations) {
  const byPlate = new Map()
  for (const v of violations) {
    const key = plateKey(v)
    if (!key || isUnclearTenant(v.owner_company)) continue
    const tenant = v.owner_company.trim()
    if (!byPlate.has(key)) byPlate.set(key, new Map())
    const stats = byPlate.get(key)
    const cur = stats.get(tenant) || { count: 0, lastAt: 0 }
    cur.count += 1
    cur.lastAt = Math.max(cur.lastAt, new Date(v.checked_at).getTime())
    stats.set(tenant, cur)
  }
  const resolved = new Map()
  for (const [key, stats] of byPlate) {
    let best = null
    for (const [tenant, s] of stats) {
      if (!best || s.count > best.s.count || (s.count === best.s.count && s.lastAt > best.s.lastAt)) best = { tenant, s }
    }
    if (best) resolved.set(key, best.tenant)
  }
  return resolved
}

function monthKeyOf(iso) {
  return jstDateOnly(iso).slice(0, 7) // 'YYYY-MM'
}

function monthLabelOf(key) {
  const [y, m] = key.split('-')
  return `${y}年${Number(m)}月`
}

// 直近nか月分の年月キー（今月を含む・古い→新しい順）。UTCの年月演算だけで
// 求めているため実行環境のタイムゾーンに依存しない（todayJST() で起点をJSTに揃える）。
// 月別台数推移の「過去1年」「過去3年」切替（2026-08-25）はこの関数にn=12/36を渡して使う
function lastNMonthKeys(n) {
  const [y, m] = todayJST().split('-').map(Number)
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

const RANKING_TOP_N = 8

// テナント別／車別ランキングの集計。mode: 'all'（総累計）| 'year'（過去1年）
function buildRanking(violations, resolvedTenants, by, mode, cutoffMonthKey) {
  const rows = mode === 'year' ? violations.filter((v) => monthKeyOf(v.checked_at) >= cutoffMonthKey) : violations
  const map = new Map()
  if (by === 'tenant') {
    for (const v of rows) {
      const key = plateKey(v)
      const tenant = key ? resolvedTenants.get(key) : null
      if (!tenant) continue // 一度も紐付いていない車はテナント別ランキングには数えない
      map.set(tenant, (map.get(tenant) || 0) + 1)
    }
    return [...map.entries()]
      .map(([label, count]) => ({ key: label, label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, RANKING_TOP_N)
  }
  for (const v of rows) {
    const key = plateKey(v)
    if (!key) continue
    const cur = map.get(key) || { count: 0, region: v.plate_region, number: v.plate_number }
    cur.count += 1
    map.set(key, cur)
  }
  return [...map.entries()]
    .map(([key, v]) => {
      const tenant = resolvedTenants.get(key)
      const plate = `${v.region || ''} ${v.number || ''}`.trim() || '（ナンバー未入力）'
      return { key, label: tenant ? `${plate}（${tenant}）` : plate, count: v.count }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, RANKING_TOP_N)
}

// 違反車両一覧。日報入力（各日の日報詳細）とは独立し、日を跨って検索・確認できる画面。
export default function ParkingViolations() {
  const user = getCurrentUser()
  // 違反車両の書き込みは owner・備品出庫限定ロール（2026-08-25追加）どちらも不可
  const isOwner = isLimitedRole(user)
  const [violations, setViolations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('date') // 'date'（日付順） | 'rank'（累計回数順）
  // 検索（2026-08-13。日報一覧の検索欄と同じ挙動に統一: 虫眼鏡タップで開閉し、
  // 閉じると入力文字もクリアする）
  const [searchOpen, setSearchOpen] = useState(false)
  // ヘッダーの「＋」から直接登録するとき用。本日の日報の id を持つ（2026-08-10）。
  // 準備中（日報の取得/作成中）は null のまま、準備できたらモーダルを開く
  const [quickAddReportId, setQuickAddReportId] = useState(null)
  const [preparingQuickAdd, setPreparingQuickAdd] = useState(false)
  // 「＋」を押すたびに空の新規入力にするため、その回に新規作成した記録の id だけを保持し、
  // モーダル内には常にこの id 一覧に含まれる分だけを表示する（当日の既存記録は出さない。2026-08-19）
  const [quickAddIds, setQuickAddIds] = useState([])
  // 明細クリックで開く詳細（写真・項目の閲覧/編集）モーダル。選んだレコードを保持する（2026-08-11）
  const [selected, setSelected] = useState(null)
  // ダッシュボードのランキング切替（2026-08-25。総累計 / 過去1年）
  const [tenantRankMode, setTenantRankMode] = useState('year')
  const [vehicleRankMode, setVehicleRankMode] = useState('year')
  // 月別台数推移の表示期間切替（2026-08-25追加。過去1年 / 過去3年）。ランキングの
  // 「過去1年」絞り込みや年月グループの既定開閉とは無関係の、グラフ専用の状態
  const [trendRangeMonths, setTrendRangeMonths] = useState(12)
  // 年月グループの開閉状態。ユーザーが手で切り替えた分だけ既定値からの例外として持つ
  // （処理ログ・残留塩素等検査の年月グループと同じやり方）
  const [collapseOverrides, setCollapseOverrides] = useState({})

  const load = useCallback(() => {
    setLoading(true)
    return fetchParkingViolations()
      .then(setViolations)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 「＋」ボタン。この一覧は日を跨るため、新規登録は常に本日分として扱う
  // （現行アプリの現場での「今すぐ記録する」用途に合わせる。他日の追加は日報詳細から）。
  // 本日の日報が無ければここで作成する（既にあれば作成済みのものがそのまま返る）
  async function handleOpenQuickAdd() {
    if (preparingQuickAdd || isOwner) return
    setPreparingQuickAdd(true)
    setError('')
    setQuickAddIds([])
    try {
      const report = await createReport(todayJST())
      setQuickAddReportId(report.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setPreparingQuickAdd(false)
    }
  }

  // モーダルを閉じたら一覧を読み直す（今の登録分を反映するため）
  function handleCloseQuickAdd() {
    setQuickAddReportId(null)
    load()
  }

  function handleToggleSearch() {
    if (searchOpen) {
      setSearchOpen(false)
      setQuery('')
    } else {
      setSearchOpen(true)
    }
  }

  // 明細クリックで開く詳細モーダルの保存・削除。フィールドの更新結果には report_date が
  // 含まれない（更新APIは parking_violations テーブルの列だけを返すため）ので、
  // 既存の行に上書きマージして日報一覧へのリンクなど他の情報を保つ
  function handleDetailSaved(updated) {
    setViolations((prev) => prev.map((v) => (v.id === updated.id ? { ...v, ...updated } : v)))
    setSelected(null)
  }

  async function handleDetailDelete(id) {
    setViolations((prev) => prev.filter((v) => v.id !== id))
    setSelected(null)
    try {
      await deleteParkingViolation(id)
    } catch (err) {
      setError(err.message)
      load()
    }
  }

  // 同一ナンバーの累計回数
  const countByPlate = useMemo(() => {
    const map = new Map()
    for (const v of violations) {
      const key = plateKey(v)
      if (!key) continue
      map.set(key, (map.get(key) || 0) + 1)
    }
    return map
  }, [violations])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = violations
    if (q) {
      list = list.filter((v) =>
        [v.plate_region, v.plate_number, v.owner_company, v.maker, v.model, v.note]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q))
      )
    }
    const sorted = [...list]
    if (sort === 'rank') {
      sorted.sort((a, b) => {
        const diff = (countByPlate.get(plateKey(b)) || 0) - (countByPlate.get(plateKey(a)) || 0)
        if (diff !== 0) return diff
        return new Date(b.checked_at) - new Date(a.checked_at)
      })
    } else {
      sorted.sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at))
    }
    return sorted
  }, [violations, query, sort, countByPlate])

  // 車とテナントの紐付け（2026-08-25）。ダッシュボードの集計はこの解決結果を使う
  const resolvedTenants = useMemo(() => resolveTenantsByPlate(violations), [violations])
  // ランキングの「過去1年」絞り込み・年月グループの既定開閉は常に直近1年基準（月別台数
  // 推移の表示期間切替とは独立させる。2026-08-25）
  const monthKeys = useMemo(() => lastNMonthKeys(12), [])
  const cutoffMonthKey = monthKeys[0]

  // 月別台数推移だけは表示期間（過去1年/過去3年）を切り替えられる（2026-08-25）。
  // 3年（36か月）表示では月名だけだと年をまたいで同じ表記が繰り返され紛らわしいため、
  // 「YY/M」形式にする（グラフ側は詰まった月をまばらにしか表示しないが、ラベル自体は
  // どの時点でも一意に決まるようにしておく）
  const trendMonthKeys = useMemo(() => lastNMonthKeys(trendRangeMonths), [trendRangeMonths])

  const monthlyTrend = useMemo(() => {
    const counts = new Map(trendMonthKeys.map((k) => [k, 0]))
    for (const v of violations) {
      const k = monthKeyOf(v.checked_at)
      if (counts.has(k)) counts.set(k, counts.get(k) + 1)
    }
    return trendMonthKeys.map((k) => {
      const [y, m] = k.split('-')
      return {
        key: k,
        shortLabel: trendRangeMonths <= 12 ? `${Number(m)}月` : `${y.slice(2)}/${Number(m)}`,
        fullLabel: monthLabelOf(k),
        count: counts.get(k),
      }
    })
  }, [violations, trendMonthKeys, trendRangeMonths])

  const tenantRanking = useMemo(
    () => buildRanking(violations, resolvedTenants, 'tenant', tenantRankMode, cutoffMonthKey),
    [violations, resolvedTenants, tenantRankMode, cutoffMonthKey]
  )
  const vehicleRanking = useMemo(
    () => buildRanking(violations, resolvedTenants, 'vehicle', vehicleRankMode, cutoffMonthKey),
    [violations, resolvedTenants, vehicleRankMode, cutoffMonthKey]
  )

  // 年月ごとのグルーピング（2026-08-25）。ランキング順（累計回数順）は日付を跨いだ
  // 全期間での順位付けのため、年月グルーピングとは相性が悪く対象外とする
  // （日付順のときだけ年月でグルーピングする）
  const groupedByMonth = useMemo(() => {
    if (sort !== 'date') return null
    const map = new Map()
    for (const v of filtered) {
      const k = monthKeyOf(v.checked_at)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(v)
    }
    return [...map.entries()]
  }, [filtered, sort])

  function isMonthOpen(key) {
    const override = collapseOverrides[key]
    if (override !== undefined) return override
    return key >= cutoffMonthKey // 直近1年分は既定で開き、それより古い年月は既定で閉じる
  }
  function toggleMonth(key) {
    setCollapseOverrides((prev) => ({ ...prev, [key]: !isMonthOpen(key) }))
  }

  // 明細行の描画。日付順（年月グルーピングあり）・累計回数順（フラット表示）の
  // どちらからも同じ見た目で使えるよう共通化する
  function renderRow(v) {
    const key = plateKey(v)
    const count = key ? countByPlate.get(key) || 0 : 0
    return (
      <li key={v.id}>
        <div
          className={`parking-list-row${isOwner ? '' : ' is-clickable'}`}
          onClick={isOwner ? undefined : () => setSelected(v)}
          role={isOwner ? undefined : 'button'}
          tabIndex={isOwner ? undefined : 0}
          onKeyDown={
            isOwner
              ? undefined
              : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelected(v)
                  }
                }
          }
        >
          <div className="parking-list-main">
            <div className="parking-list-main-left">
              {/* 残留塩素一覧の日付見出しと同じ「日付だけ・太字」の見せ方に揃える
                  （2026-08-11。以前は時刻まで表示していた） */}
              <span className="parking-list-date">{formatReportDate(jstDateOnly(v.checked_at))}</span>
              <span className="parking-list-plate">
                {v.plate_region || v.plate_number ? `${v.plate_region || ''} ${v.plate_number || ''}`.trim() : '（ナンバー未入力）'}
              </span>
              {count > 1 && <span className="parking-list-count">累計{count}回</span>}
            </div>
            {/* 分類（無断駐車等）は右上に置く（2026-08-19。以前は3行目だったが、
                日報へのジャンプボタン廃止に伴い1行目の右側へ寄せて2行構成にした） */}
            {v.violations.length > 0 && (
              <div className="parking-list-tags">
                {v.violations.map((t) => (
                  <span key={t} className="parking-list-tag">
                    {VIOLATION_LABELS[t] || t}
                  </span>
                ))}
              </div>
            )}
          </div>
          {(v.owner_company || v.maker || v.model) && (
            // 表示順・色は所有会社（テナント名。青太字）→メーカー（黒）→車種（黒）
            // の順に固定する（2026-08-14。ユーザー要望による2行目の並び）
            <div className="parking-list-sub">
              {v.owner_company && <span className="parking-list-owner">{v.owner_company}</span>}
              {v.maker && <span className="parking-list-maker">{v.maker}</span>}
              {v.model && <span className="parking-list-model">{v.model}</span>}
            </div>
          )}
          {v.note && <p className="parking-list-note">{v.note}</p>}
        </div>
      </li>
    )
  }

  return (
    <div className="ui-page">
      <AppHeader />
      {/* PCではウインドウ幅を十分に使う（2026-08-25。ダッシュボードのグラフ・ランキングの
          文字が隠れないようにするための依頼）。max-width指定を持たないため、
          Logs.jsx・Archive.jsx・日報カレンダー表示（.is-calendar）と同じ全幅表示になる */}
      <div className="ui-container reports-container app-scroll">
        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}

        {/* ダッシュボード（月別推移・テナント別/車別ランキング。2026-08-25新規）。
            記録が無いうちは出しても意味がないため、1件以上あるときだけ表示する */}
        {!loading && violations.length > 0 && (
          <div className="parking-dashboard">
            <div className="ui-card parking-chart-card">
              <div className="ui-card-title">
                月別台数推移
                <div className="ui-segmented parking-chart-toggle ui-card-title-action" role="group" aria-label="表示期間">
                  <button
                    type="button"
                    className={`ui-segmented-btn${trendRangeMonths === 12 ? ' is-active' : ''}`}
                    aria-pressed={trendRangeMonths === 12}
                    onClick={() => setTrendRangeMonths(12)}
                  >
                    過去1年
                  </button>
                  <button
                    type="button"
                    className={`ui-segmented-btn${trendRangeMonths === 36 ? ' is-active' : ''}`}
                    aria-pressed={trendRangeMonths === 36}
                    onClick={() => setTrendRangeMonths(36)}
                  >
                    過去3年
                  </button>
                </div>
              </div>
              <MonthlyTrendChart data={monthlyTrend} />
            </div>
            <div className="ui-card parking-chart-card">
              <div className="ui-card-title">
                テナント別台数ランキング
                <div className="ui-segmented parking-chart-toggle ui-card-title-action" role="group" aria-label="集計期間">
                  <button
                    type="button"
                    className={`ui-segmented-btn${tenantRankMode === 'all' ? ' is-active' : ''}`}
                    aria-pressed={tenantRankMode === 'all'}
                    onClick={() => setTenantRankMode('all')}
                  >
                    総累計
                  </button>
                  <button
                    type="button"
                    className={`ui-segmented-btn${tenantRankMode === 'year' ? ' is-active' : ''}`}
                    aria-pressed={tenantRankMode === 'year'}
                    onClick={() => setTenantRankMode('year')}
                  >
                    過去1年
                  </button>
                </div>
              </div>
              <RankingBarList items={tenantRanking} emptyText="テナントが判明している記録がありません。" />
            </div>
            <div className="ui-card parking-chart-card">
              <div className="ui-card-title">
                車別台数ランキング
                <div className="ui-segmented parking-chart-toggle ui-card-title-action" role="group" aria-label="集計期間">
                  <button
                    type="button"
                    className={`ui-segmented-btn${vehicleRankMode === 'all' ? ' is-active' : ''}`}
                    aria-pressed={vehicleRankMode === 'all'}
                    onClick={() => setVehicleRankMode('all')}
                  >
                    総累計
                  </button>
                  <button
                    type="button"
                    className={`ui-segmented-btn${vehicleRankMode === 'year' ? ' is-active' : ''}`}
                    aria-pressed={vehicleRankMode === 'year'}
                    onClick={() => setVehicleRankMode('year')}
                  >
                    過去1年
                  </button>
                </div>
              </div>
              <RankingBarList items={vehicleRanking} />
            </div>
          </div>
        )}

        {/* 並び順・検索・＋（2026-08-26。以前は機能ヘッダに置いていたが、グラフ・
            ランキングの下、一覧表の上に移動してほしいとの依頼を受けて通常の行にした。
            固定表示（sticky）は不要になったため .ui-toolbar を使う */}
        <div className="ui-toolbar">
          <div className="ui-segmented" role="group" aria-label="並び順">
            <button
              type="button"
              className={`ui-segmented-btn${sort === 'date' ? ' is-active' : ''}`}
              aria-pressed={sort === 'date'}
              onClick={() => setSort('date')}
            >
              日付順
            </button>
            <button
              type="button"
              className={`ui-segmented-btn${sort === 'rank' ? ' is-active' : ''}`}
              aria-pressed={sort === 'rank'}
              onClick={() => setSort('rank')}
            >
              累計回数順
            </button>
          </div>
          <button
            type="button"
            className={`icon-btn-search${searchOpen ? ' is-active' : ''}`}
            onClick={handleToggleSearch}
            aria-label="ナンバー・会社名などで検索"
            aria-pressed={searchOpen}
            title="ナンバー・会社名などで検索"
          >
            <IconSearch size={20} />
          </button>
          {!isOwner && (
            <button
              type="button"
              className="icon-btn-add"
              onClick={handleOpenQuickAdd}
              disabled={preparingQuickAdd}
              aria-label="違反車両を記録（本日分）"
              title="違反車両を記録（本日分）"
            >
              ＋
            </button>
          )}
        </div>
        {searchOpen && (
          <div className="reports-search-bar">
            <IconSearch size={18} />
            <input
              type="search"
              className="reports-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ナンバー・会社名などで検索"
              aria-label="ナンバー・会社名などで検索"
              autoFocus
            />
            {query && (
              <button
                type="button"
                className="reports-search-clear"
                onClick={() => setQuery('')}
                aria-label="検索文字をクリア"
              >
                ×
              </button>
            )}
          </div>
        )}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : filtered.length === 0 ? (
          <p className="settings-hint">
            {violations.length === 0 ? 'まだ違反車両の記録がありません。' : '該当する記録がありません。'}
          </p>
        ) : sort === 'date' ? (
          <div className="parking-groups">
            {groupedByMonth.map(([mk, rows]) => {
              const open = isMonthOpen(mk)
              return (
                <div className="parking-month-group" key={mk}>
                  <button
                    type="button"
                    className="parking-month-head"
                    onClick={() => toggleMonth(mk)}
                    aria-expanded={open}
                  >
                    <IconChevronRight size={16} className={`parking-month-toggle-icon${open ? ' is-open' : ''}`} />
                    <span className="parking-month-label">{monthLabelOf(mk)}</span>
                    <span className="parking-month-count">{rows.length}件</span>
                  </button>
                  {open && <ul className="parking-list">{rows.map(renderRow)}</ul>}
                </div>
              )
            })}
          </div>
        ) : (
          <ul className="parking-list">{filtered.map(renderRow)}</ul>
        )}
      </div>

      {/* ヘッダーの「＋」からの新規登録（2026-08-10）。この一覧は日を跨るため常に本日分として扱い、
          日報詳細と同じ入力欄（写真撮影・ナンバー等・AI読み取り）をそのままモーダルで開く */}
      {quickAddReportId && (
        <div className="ui-overlay is-nested" role="dialog" aria-modal="true" onClick={handleCloseQuickAdd}>
          <div className="ui-modal is-sm" onClick={(e) => e.stopPropagation()}>
            <div className="ui-modal-head">
              {/* 下に黄色枠の「違反車両」見出しがあるため、ここでは日付だけにする（2026-08-19） */}
              <h3 className="ui-modal-title">{formatReportDate(todayJST())}</h3>
              <button type="button" className="icon-btn-close" onClick={handleCloseQuickAdd} aria-label="閉じる">
                ×
              </button>
            </div>
            <div className="ui-modal-body is-stacked">
              <ReportParkingViolations
                reportId={quickAddReportId}
                readOnly={false}
                filterIds={quickAddIds}
                onCreated={(id) => setQuickAddIds((prev) => [...prev, id])}
              />
            </div>
          </div>
        </div>
      )}

      {/* 明細クリックで開く詳細（車両写真・項目の閲覧/編集。2026-08-11） */}
      {selected && (
        <ParkingViolationDetail
          violation={selected}
          readOnly={isOwner}
          onClose={() => setSelected(null)}
          onSaved={handleDetailSaved}
          onDelete={handleDetailDelete}
        />
      )}
    </div>
  )
}
