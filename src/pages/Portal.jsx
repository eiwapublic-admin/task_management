import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import {
  IconArchive,
  IconBox,
  IconCar,
  IconCheckCircle,
  IconClipboard,
  IconDroplet,
  IconGear,
  IconKanban,
  IconList,
  IconYen,
} from '../components/Icons'
import { getCurrentUser } from '../lib/auth'
import { fetchTasks } from '../lib/tasks'
import { fetchEquipmentItems } from '../lib/equipment'
import {
  currentMonthJST,
  currentYearJST,
  fetchChlorineTests,
  fetchInspections,
  fetchParkingViolations,
  fetchReports,
  formatReportDate,
  jstDateOnly,
  todayJST,
} from '../lib/reports'
import { dueStatus } from '../lib/format'
import { STATUS_DONE } from '../lib/status'
import './Dashboard.css'
import './Portal.css'

// ダッシュボード 兼 ポータル画面（2026-08-12）
//
// 各機能を「象徴的な統計値がついたボタン」として並べ、押すとその機能へ移動する。
// 数字を見て気になったところから入れるようにするのが狙いで、ポータル自体は
// 読み取り専用（ここでデータを書き換えることはしない）。
//
// アプリ起動時の既定表示はカンバン（/）のまま。カンバン以外はまだ正式リリースでは
// ないため、この画面は「ロゴをタップして開く場所」に留めている（設計書 4-3）。
//
// 統計はそれぞれ別のAPIから取るので Promise.allSettled で束ね、1つ失敗しても
// 他のカードは数字を出せるようにする（失敗したカードだけ「—」になる）。

// JST の「今日」を「8月12日（火）」形式で表す
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function todayLabel() {
  const [y, m, d] = todayJST().split('-').map(Number)
  // 曜日は暦上の日付から求める（タイムゾーン換算を挟むとずれるので Date.UTC で固定する）
  const w = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${y}年${m}月${d}日（${w}）`
}

function greeting() {
  // 端末のローカル時刻でよい（挨拶なので厳密なJST換算までは要らない）
  const h = new Date().getHours()
  if (h < 11) return 'おはようございます'
  if (h < 18) return 'おつかれさまです'
  return 'おつかれさまです'
}

export default function Portal() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  const isOwner = user?.role === 'owner'

  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const month = currentMonthJST()
    const year = currentYearJST()

    async function load() {
      const results = await Promise.allSettled([
        isOwner ? Promise.resolve([]) : fetchTasks(),
        fetchReports(),
        fetchEquipmentItems(),
        fetchParkingViolations(),
        fetchChlorineTests({ year }),
        fetchInspections({ month }),
      ])
      if (!alive) return
      const [tasks, reports, items, parking, chlorine, inspections] = results.map((r) =>
        r.status === 'fulfilled' ? r.value : null,
      )
      // 全滅したときだけ画面上部にエラーを出す（一部失敗はそのカードの「—」で表現）
      if (results.every((r) => r.status === 'rejected')) {
        setError(results[0].reason?.message || 'データを取得できませんでした。')
      }
      setStats({ tasks, reports, items, parking, chlorine, inspections, month, year })
      setLoading(false)
    }

    load()
    return () => {
      alive = false
    }
  }, [isOwner])

  const cards = useMemo(() => {
    const month = stats?.month ?? currentMonthJST()
    const year = stats?.year ?? currentYearJST()
    const today = todayJST()

    // --- タスク（カンバン）---
    const tasks = stats?.tasks
    const todo = tasks?.filter((t) => t.status === '未処理').length
    const inProgress = tasks?.filter((t) => t.status === '対応中').length
    const overdue = tasks?.filter(
      (t) => t.status !== STATUS_DONE && dueStatus(t.due_date)?.level === 'overdue',
    ).length

    // --- 日報 ---
    const reports = stats?.reports
    const monthReports = reports?.filter((r) => (r.report_date || '').startsWith(month))
    const hasToday = reports?.some((r) => r.report_date === today)

    // --- 備品 ---
    const items = stats?.items
    const lowStock = items?.filter(
      (i) => i.track_stock && i.warn_qty != null && i.stock_qty != null && i.stock_qty <= i.warn_qty,
    ).length

    // --- 違反車両 ---
    const parking = stats?.parking
    const monthParking = parking?.filter((p) => jstDateOnly(p.checked_at).startsWith(month)).length

    // --- 残留塩素等検査 ---
    const chlorine = stats?.chlorine
    // API は新しい順で返すので先頭が最終測定
    const lastChlorine = chlorine?.[0]?.tested_at

    // --- 自主検査表 ---
    const inspections = stats?.inspections
    const inspectedDays = inspections
      ? new Set(inspections.map((i) => i.inspected_on)).size
      : undefined

    const monthLabel = `${Number(month.slice(5, 7))}月`

    const all = [
      {
        key: 'tasks',
        label: 'タスク',
        icon: <IconKanban size={24} />,
        path: '/',
        value: todo,
        unit: '件',
        caption: '未処理',
        sub:
          tasks == null
            ? '取得できませんでした'
            : `対応中 ${inProgress} 件 ・ 期限超過 ${overdue} 件`,
        alert: overdue > 0,
        staffOnly: true,
      },
      {
        key: 'reports',
        label: '日報',
        icon: <IconClipboard size={24} />,
        path: '/reports',
        value: monthReports?.length,
        unit: '日',
        caption: `${monthLabel}の記録`,
        sub: reports == null ? '取得できませんでした' : hasToday ? '本日分は記録済み' : '本日分は未入力',
        alert: reports != null && !hasToday,
      },
      {
        key: 'equipment',
        label: '備品',
        icon: <IconBox size={24} />,
        path: '/equipment',
        value: lowStock,
        unit: '件',
        caption: '在庫わずか',
        sub: items == null ? '取得できませんでした' : `登録 ${items.length} 品目`,
        alert: lowStock > 0,
      },
      {
        key: 'inspections',
        label: '自主検査',
        icon: <IconCheckCircle size={24} />,
        path: '/reports/inspections',
        value: inspectedDays,
        unit: '日',
        caption: `${monthLabel}の実施`,
        sub: inspections == null ? '取得できませんでした' : '日常の防火・避難点検',
      },
      {
        key: 'parking',
        label: '違反車両',
        icon: <IconCar size={24} />,
        path: '/reports/parking',
        value: monthParking,
        unit: '件',
        caption: `${monthLabel}の記録`,
        sub: parking == null ? '取得できませんでした' : `累計 ${parking.length} 件`,
      },
      {
        key: 'chlorine',
        label: '残留塩素',
        icon: <IconDroplet size={24} />,
        path: '/reports/chlorine',
        value: chlorine?.length,
        unit: '件',
        caption: `${year}年の測定`,
        sub:
          chlorine == null
            ? '取得できませんでした'
            : lastChlorine
              ? `最終測定 ${formatReportDate(jstDateOnly(lastChlorine))}`
              : 'まだ記録がありません',
      },
    ]

    return all.filter((c) => !(isOwner && c.staffOnly))
  }, [stats, isOwner])

  // 統計を出すほどではない画面への導線。押すとその画面へ移動する
  const links = [
    { label: 'アーカイブ', icon: <IconArchive size={20} />, path: '/archive', staffOnly: true },
    { label: '処理ログ', icon: <IconList size={20} />, path: '/logs', staffOnly: true },
    { label: '備品マスタ', icon: <IconBox size={20} />, path: '/equipment/items', staffOnly: true },
    { label: '作業定型文', icon: <IconClipboard size={20} />, path: '/reports/templates', staffOnly: true },
    { label: '従量課金事項', icon: <IconYen size={20} />, path: '/usage', staffOnly: true },
    { label: '設定', icon: <IconGear size={20} />, path: '/settings', staffOnly: true },
  ].filter((l) => !(isOwner && l.staffOnly))

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide portal-container">
        <header className="portal-hero">
          <p className="portal-hero-date">{todayLabel()}</p>
          <h1 className="portal-hero-title">
            {greeting()}
            {user?.display_name ? `、${user.display_name} さん` : ''}
          </h1>
        </header>

        {error && (
          <p className="dashboard-banner dashboard-error" role="alert">
            {error}
          </p>
        )}

        <div className="portal-grid">
          {cards.map((card) => (
            <button
              key={card.key}
              type="button"
              className={`portal-card is-${card.key}`}
              onClick={() => navigate(card.path)}
            >
              <span className="portal-card-head">
                <span className="portal-card-icon" aria-hidden="true">
                  {card.icon}
                </span>
                <span className="portal-card-label">{card.label}</span>
              </span>
              <span className="portal-card-stat">
                <span className={`portal-card-value${card.alert ? ' is-alert' : ''}`}>
                  {loading || card.value == null ? '—' : card.value}
                </span>
                <span className="portal-card-unit">{card.unit}</span>
                <span className="portal-card-caption">{card.caption}</span>
              </span>
              <span className="portal-card-sub">{loading ? '読み込み中…' : card.sub}</span>
            </button>
          ))}
        </div>

        {links.length > 0 && (
          <section className="portal-links-section">
            <h2 className="ui-group-head">
              その他
              <span className="ui-group-head-sub">記録の参照・設定</span>
            </h2>
            <div className="portal-links">
              {links.map((link) => (
                <button
                  key={link.path}
                  type="button"
                  className="portal-link"
                  onClick={() => navigate(link.path)}
                >
                  <span className="portal-link-icon" aria-hidden="true">
                    {link.icon}
                  </span>
                  {link.label}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
