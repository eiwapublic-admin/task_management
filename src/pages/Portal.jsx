import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import {
  IconAddressBook, IconBook,
  IconGauge,
  IconBox,
  IconBuildingWrench,
  IconCar,
  IconClipboard,
  IconDroplet,
  IconFolder,
  IconBell,
  IconGear,
  IconHome,
  IconKanban,
  IconList,
  IconRecycle,
  IconScale,
  IconYen,
} from '../components/Icons'
import { getCurrentUser, isLimitedRole } from '../lib/auth'
import { fetchTasks } from '../lib/tasks'
import { fetchEquipmentItems } from '../lib/equipment'
import { fetchBilmenSchedules, isUnsettled } from '../lib/bilmen'
import { fetchWasteRecords } from '../lib/waste'
import { fetchPaperRecords, fiscalYearOf, paperRowTotal } from '../lib/paper'
import { fetchMeterSummary, meterMonthLabel } from '../lib/meter'
import { electricChange } from '../lib/meterMonth'
import {
  CHLORINE_STANDARD_MIN,
  currentMonthJST,
  currentYearJST,
  daysInMonth,
  fetchChlorineTests,
  fetchClosedDays,
  fetchParkingViolations,
  fetchReports,
  formatReportDate,
  jstDateOnly,
  shiftDate,
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
// 'YYYY-MM' を delta か月ずらす
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number)
  const total = y * 12 + (m - 1) + delta
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

function lastDayOfMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

// endMonth（'YYYY-MM'）までの年度累計（4月始まり）の期間と、前年の同じ期間
function fiscalYtd(endMonth) {
  const fy = fiscalYearOf(endMonth)
  const prevEnd = shiftMonth(endMonth, -12)
  return {
    from: `${fy}-04-01`,
    to: lastDayOfMonth(endMonth),
    prevFrom: `${fy - 1}-04-01`,
    prevTo: lastDayOfMonth(prevEnd),
    label: `${fy}年度${endMonth.endsWith('-04') ? '4月' : `4〜${Number(endMonth.slice(5, 7))}月`}`,
  }
}

function sumBetween(rows, dateKey, valueOf, from, to) {
  return rows.reduce((sum, r) => (r[dateKey] >= from && r[dateKey] <= to ? sum + valueOf(r) : sum), 0)
}

// 増減比率（%）。'+4.8' / '-2.4' の形。前年が0なら出さない
function changePercent(now, prev) {
  if (now == null || !prev) return undefined
  const p = Math.round(((now - prev) / prev) * 1000) / 10
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}`
}

function formatKgTotal(kg) {
  return kg == null ? '—' : `${Math.round(kg).toLocaleString('ja-JP')}kg`
}

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

// 当月1日〜昨日のうち、休館日を除いて記録が無い日数を数える
// （日報・自主検査の「未起票日数」カードで共通に使う）
function countUnfiledDays(month, filedDates, closedDays, today) {
  const count = daysInMonth(month)
  let missing = 0
  for (let d = 1; d <= count; d += 1) {
    const date = `${month}-${String(d).padStart(2, '0')}`
    if (date >= today) break
    if (closedDays.has(date)) continue
    if (!filedDates.has(date)) missing += 1
  }
  return missing
}

export default function Portal() {
  const navigate = useNavigate()
  const user = getCurrentUser()
  // owner・備品出庫限定ロール（2026-08-25追加）はどちらもタスク管理系のカード・導線を見せない
  const isOwner = isLimitedRole(user)

  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    const month = currentMonthJST()
    const year = currentYearJST()
    const ytdFiscalYear = fiscalYearOf(shiftMonth(month, -1))

    async function load() {
      const results = await Promise.allSettled([
        isOwner ? Promise.resolve([]) : fetchTasks(),
        fetchReports(),
        fetchEquipmentItems(),
        fetchParkingViolations(),
        // 残留塩素は「過去10日間」の判定に年をまたぐ可能性があるため、年で絞らず全期間取得する
        fetchChlorineTests(),
        fetchClosedDays({ month }),
        // ビルメン（2026-09-02）。当月を起点に3ヶ月分だけ引く（カードに出すのは当月の件数と
        // 未確定件数のみで、全期間を読む必要がないため）
        fetchBilmenSchedules({ month, months: 3 }),
        // 廃棄物・古紙回収（2026-10-20 依頼で変更）: 前月までの年度累計（4月始まり）を前年の同じ期間と比べるため、
        // 前月が属する年度とその前年度を引く（廃棄物は当月の未確認件数もこの中から数える）
        Promise.all([fetchWasteRecords({ fiscalYear: ytdFiscalYear }), fetchWasteRecords({ fiscalYear: ytdFiscalYear - 1 })]),
        Promise.all([fetchPaperRecords(ytdFiscalYear), fetchPaperRecords(ytdFiscalYear - 1)]),
        // 検針（2026-10-20）。社員だけ（owner には検針を見せない。Q9）
        isOwner ? Promise.resolve(null) : fetchMeterSummary(),
      ])
      if (!alive) return
      const [tasks, reports, items, parking, chlorine, closedDays, bilmen, waste, paper, meter] = results.map((r) =>
        r.status === 'fulfilled' ? r.value : null,
      )
      // 全滅したときだけ画面上部にエラーを出す（一部失敗はそのカードの「—」で表現）
      if (results.every((r) => r.status === 'rejected')) {
        setError(results[0].reason?.message || 'データを取得できませんでした。')
      }
      setStats({ tasks, reports, items, parking, chlorine, closedDays, bilmen, waste, paper, meter, month, year })
      setLoading(false)
    }

    load()
    return () => {
      alive = false
    }
  }, [isOwner])

  const cards = useMemo(() => {
    const month = stats?.month ?? currentMonthJST()
    const today = todayJST()
    const closedDays = new Set(stats?.closedDays || [])

    // --- タスク（カンバン）---
    const tasks = stats?.tasks
    const todo = tasks?.filter((t) => t.status === '未処理').length
    const inProgress = tasks?.filter((t) => t.status === '対応中').length
    const overdue = tasks?.filter(
      (t) => t.status !== STATUS_DONE && dueStatus(t.due_date)?.level === 'overdue',
    ).length

    // --- 日報：昨日までの未起票日数（休館日を除く。2026-08-14） ---
    const reports = stats?.reports
    const monthReports = reports?.filter((r) => (r.report_date || '').startsWith(month))
    const unfiledReportDays = reports
      ? countUnfiledDays(month, new Set(monthReports.map((r) => r.report_date)), closedDays, today)
      : undefined

    // --- 備品：在庫数が最も少ない機種の在庫数（警告本数以下のときだけ赤字。2026-08-14） ---
    const items = stats?.items
    const trackedItems = items?.filter((i) => i.track_stock && i.stock_qty != null)
    const lowestItem =
      trackedItems && trackedItems.length > 0
        ? trackedItems.reduce((min, i) => (i.stock_qty < min.stock_qty ? i : min))
        : null
    const lowestBelowWarn =
      lowestItem != null && lowestItem.warn_qty != null && lowestItem.stock_qty <= lowestItem.warn_qty

    // --- 違反車両：過去30日間（当日含む）の件数（2026-08-14） ---
    const parking = stats?.parking
    const parkingSince = shiftDate(today, -29)
    const recentParking = parking?.filter((p) => jstDateOnly(p.checked_at) >= parkingSince).length

    // --- 残留塩素等検査：過去10日間（当日含む）で規定値未満（0.1未満）の検出件数（2026-08-14） ---
    const chlorine = stats?.chlorine
    // API は新しい順で返すので先頭が最終測定
    const lastChlorine = chlorine?.[0]?.tested_at
    const chlorineSince = shiftDate(today, -9)
    const belowStandardCount = chlorine?.filter((t) => {
      if (jstDateOnly(t.tested_at) < chlorineSince) return false
      return t.concentration !== null && t.concentration !== undefined && Number(t.concentration) < CHLORINE_STANDARD_MIN
    }).length

    // --- ビルメン：当月の予定件数と、日付・作業IDが未入力の「未確定」件数（2026-09-02） ---
    const bilmen = stats?.bilmen
    const monthBilmen = bilmen?.filter((s) => s.target_month === month)
    const bilmenUnsettled = monthBilmen?.filter(isUnsettled).length

    // --- 廃棄物・古紙回収：前月までの年度累計（4月始まり）と、前年の同じ期間の累計の増減比率（2026-10-20 依頼）。
    // 例: 10月に見ると、今年度4〜9月の合計を前年度4〜9月の合計と比べる ---
    const ytdEnd = shiftMonth(month, -1)
    const ytd = fiscalYtd(ytdEnd)
    const waste = stats?.waste
    const wasteNow = waste ? sumBetween(waste[0], 'record_date', (r) => Number(r.weight_kg), ytd.from, ytd.to) : null
    const wastePrev = waste ? sumBetween(waste[1], 'record_date', (r) => Number(r.weight_kg), ytd.prevFrom, ytd.prevTo) : null
    const wasteUnconfirmed = waste?.[0].filter((r) => r.record_date.startsWith(month) && !r.is_confirmed).length
    const paper = stats?.paper
    const paperNow = paper ? sumBetween(paper[0], 'collect_date', paperRowTotal, ytd.from, ytd.to) : null
    const paperPrev = paper ? sumBetween(paper[1], 'collect_date', paperRowTotal, ytd.prevFrom, ytd.prevTo) : null

    // --- 検針：検針の済んだ最新の月度の電気の使用量が、その前の月度より何%増減したか（2026-10-20） ---
    const meter = stats?.meter
    const meterChange = electricChange(meter)

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
        value: unfiledReportDays,
        unit: '日',
        caption: '未起票（昨日まで）',
        sub: reports == null ? '取得できませんでした' : `${monthLabel}の記録 ${monthReports.length} 日`,
        alert: unfiledReportDays > 0,
        // タイル右上の「本日」（2026-09-02）。日報一覧へ遷移した上で本日の詳細を
        // 開きたいので、詳細モーダルも兼ねる /reports/:date へ直接ジャンプする
        quickAction: {
          label: '本日',
          ariaLabel: '本日の日報を開く',
          onClick: () => navigate(`/reports/${today}`),
        },
      },
      {
        key: 'bilmen',
        label: 'ビルメン',
        icon: <IconBuildingWrench size={24} />,
        path: '/bilmen',
        value: monthBilmen?.length,
        unit: '件',
        caption: `${monthLabel}の予定`,
        sub:
          bilmen == null
            ? '取得できませんでした'
            : bilmenUnsettled > 0
              ? `未確定 ${bilmenUnsettled} 件（日付・作業IDが未入力）`
              : 'すべて確定済み',
        alert: bilmenUnsettled > 0,
      },
      {
        key: 'equipment',
        label: '備品',
        icon: <IconBox size={24} />,
        path: '/equipment',
        value: lowestItem?.stock_qty,
        unit: '点',
        caption: '在庫最少',
        sub: items == null ? '取得できませんでした' : lowestItem ? lowestItem.name : '在庫管理の対象がありません',
        alert: lowestBelowWarn,
      },
      {
        key: 'parking',
        label: '違反車両',
        icon: <IconCar size={24} />,
        path: '/reports/parking',
        value: recentParking,
        unit: '件',
        caption: '過去30日',
        sub: parking == null ? '取得できませんでした' : `累計 ${parking.length} 件`,
        // タイル右上の「＋」（2026-09-02）。違反車両一覧へ遷移した上で新規入力を
        // 開きたいので、遷移先へその意図を渡す（ParkingViolations.jsx側で受け取る）。
        // owner（小泉産業様）は違反車両の登録ができないため出さない
        quickAction: isOwner
          ? undefined
          : {
              label: '＋',
              ariaLabel: '違反車両を新規記録',
              onClick: () => navigate('/reports/parking', { state: { openNew: true } }),
            },
      },
      {
        key: 'chlorine',
        label: '残留塩素',
        icon: <IconDroplet size={24} />,
        path: '/reports/chlorine',
        value: belowStandardCount,
        unit: '件',
        caption: '規定値未満（10日間）',
        sub:
          chlorine == null
            ? '取得できませんでした'
            : lastChlorine
              ? `最終測定 ${formatReportDate(jstDateOnly(lastChlorine))}`
              : 'まだ記録がありません',
        alert: belowStandardCount > 0,
        // タイル右上の「＋」（2026-09-02）。残留塩素画面へ遷移した上で新規入力を開く。
        // owner（小泉産業様）は測定の登録ができないため出さない
        quickAction: isOwner
          ? undefined
          : {
              label: '＋',
              ariaLabel: '残留塩素の測定を新規記録',
              onClick: () => navigate('/reports/chlorine', { state: { openNew: true } }),
            },
      },
      {
        key: 'meter',
        label: '検針',
        icon: <IconGauge size={24} />,
        path: '/meter',
        value:
          meterChange?.percent != null ? `${meterChange.percent > 0 ? '+' : ''}${meterChange.percent.toFixed(1)}` : undefined,
        unit: '%',
        caption: meterChange?.current
          ? `${Number(meterChange.current.month.slice(5, 7))}月度の電気（前月度比）`
          : '電気（前月度比）',
        sub:
          meter == null
            ? '取得できませんでした'
            : !meter.latestMonth
              ? 'まだ記録がありません'
              : `最新 ${meterMonthLabel(meter.latestMonth)}${
                  meterChange.latest.complete ? '' : `（入力中 ${meterChange.latest.entered}/${meterChange.latest.count}）`
                }`,
        staffOnly: true,
      },
      {
        key: 'waste',
        label: '廃棄物',
        icon: <IconScale size={24} />,
        path: '/waste',
        value: changePercent(wasteNow, wastePrev),
        unit: '%',
        caption: `${ytd.label}の累計（前年同期比）`,
        sub:
          waste == null
            ? '取得できませんでした'
            : `${formatKgTotal(wasteNow)}（前年 ${formatKgTotal(wastePrev)}）${
                wasteUnconfirmed > 0 ? `・未確認 ${wasteUnconfirmed} 件` : ''
              }`,
        alert: wasteUnconfirmed > 0,
      },
      {
        key: 'paper',
        label: '古紙回収',
        icon: <IconRecycle size={24} />,
        path: '/paper',
        value: changePercent(paperNow, paperPrev),
        unit: '%',
        caption: `${ytd.label}の累計（前年同期比）`,
        sub: paper == null ? '取得できませんでした' : `${formatKgTotal(paperNow)}（前年 ${formatKgTotal(paperPrev)}）`,
      },
    ]

    return all.filter((c) => !(isOwner && c.staffOnly))
  }, [stats, isOwner, navigate])

  // 統計を出すほどではない画面への導線。押すとその画面へ移動する。
  // 「その他機能」「マスタ」「管理」の3グループに分けて並べる（2026-09-05。
  // アーカイブへのリンクはここからは削除し、KanbanBoard側の導線のみに一本化した）
  const filterLinks = (list) => list.filter((l) => !(isOwner && l.staffOnly))

  const linkGroups = [
    {
      key: 'other',
      title: 'その他機能',
      sub: '記録の参照',
      links: filterLinks([
        { label: '雛形ファイル', icon: <IconFolder size={20} />, path: '/documents', staffOnly: true },
        { label: '連絡帳', icon: <IconAddressBook size={20} />, path: '/contacts', staffOnly: true },
        { label: '業務マニュアル', icon: <IconBook size={20} />, path: '/manuals', staffOnly: true },
      ]),
    },
    {
      key: 'master',
      title: 'マスタ',
      sub: '各種マスタの管理',
      links: filterLinks([
        { label: '日報用作業定型文', icon: <IconClipboard size={20} />, path: '/reports/templates', staffOnly: true },
        { label: '備品マスタ', icon: <IconBox size={20} />, path: '/equipment/items', staffOnly: true },
        { label: 'テナントマスタ', icon: <IconHome size={20} />, path: '/equipment/tenants', staffOnly: true },
        { label: '検針マスタ', icon: <IconGauge size={20} />, path: '/meter/masters', staffOnly: true },
        // ビルメン作業マスタは owner（小泉産業様）も閲覧できる（docs/bilmen-plan.md 10章）
        { label: 'ビルメン作業マスタ', icon: <IconBuildingWrench size={20} />, path: '/bilmen/masters' },
      ]),
    },
    {
      key: 'admin',
      title: '管理',
      sub: '設定・運用管理',
      links: filterLinks([
        { label: '処理ログ', icon: <IconList size={20} />, path: '/logs', staffOnly: true },
        { label: 'タスク設定', icon: <IconGear size={20} />, path: '/settings', staffOnly: true },
        { label: '従量課金事項', icon: <IconYen size={20} />, path: '/usage', staffOnly: true },
        { label: 'リマインダー', icon: <IconBell size={20} />, path: '/reminders', staffOnly: true },
      ]),
    },
  ].filter((g) => g.links.length > 0)

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-wide portal-container app-scroll">
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
            <div key={card.key} className="portal-card-slot">
              <button
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
              {/* カード本体のボタンとは別の兄弟要素として右上に重ねる（2026-09-02）。
                  ボタンの入れ子はHTML上不正なため、position:absoluteで角に載せるだけに
                  留め、ここ以外を押せば従来どおりカードの遷移が動く */}
              {card.quickAction && (
                <button
                  type="button"
                  className="portal-card-quick"
                  onClick={(e) => {
                    e.stopPropagation()
                    card.quickAction.onClick()
                  }}
                  aria-label={card.quickAction.ariaLabel}
                  title={card.quickAction.ariaLabel}
                >
                  {card.quickAction.label}
                </button>
              )}
            </div>
          ))}
        </div>

        {linkGroups.length > 0 && (
          // グループを横に並べ、各グループの中でリンクを縦に積む（2026-09-05。依頼）。
          // 従来は「グループごとに横1行、リンクは横に折り返し」だったのを転置した。
          // 上のメインカードと同じグリッド（auto-fit + 同じ gap）を使うことで、
          // 幅が3列に収まる画面ではメインカードの列位置とおおむね揃う。
          <div className="portal-link-groups">
            {linkGroups.map((group) => (
              <section key={group.key} className="portal-links-section">
                <h2 className="ui-group-head">
                  {group.title}
                  <span className="ui-group-head-sub">{group.sub}</span>
                </h2>
                <div className="portal-links">
                  {group.links.map((link) => (
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
