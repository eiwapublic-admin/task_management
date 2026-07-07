// 録画用モックサーバー: dist の静的配信 + /api/* + Supabase REST (/rest/v1/*) 互換
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { extname, join } from 'node:path'

const DIST = process.env.DIST_DIR
const PORT = 8788

const now = Date.now()
const h = (n) => new Date(now - n * 3600_000).toISOString()
const today = new Date(now).toISOString().slice(0, 10)

const tasks = [
  {
    id: 't1', gmail_thread_id: 'th1', gmail_message_id: 'm1',
    title: 'システム保守契約の見積依頼への対応', assignee: '西川', status: '未処理',
    due_date: null, sender: 'tanaka@yamato-kensetsu.example.co.jp', subject: '【見積依頼】システム保守契約更新の件',
    body_preview: '株式会社ヤマト建設の田中です。いつもお世話になっております。\n現在ご契約中のシステム保守契約が来月末で満了となるため、更新のお見積りをお願いしたくご連絡いたしました。\n前回同様の内容で、2年契約の場合の金額もあわせてご提示いただけますと幸いです。\n\n担当：西川様',
    classification_note: '見積依頼のメール。本文に「担当：西川様」とあり、契約更新に関する営業対応のため西川さんに割り当てました。',
    sender_display: 'ヤマト建設 田中様', sender_email: 'tanaka@yamato-kensetsu.example.co.jp',
    source: 'email', received_at: h(2), created_at: h(2), updated_at: h(2),
  },
  {
    id: 't2', gmail_thread_id: 'th2', gmail_message_id: 'm2',
    title: '賃貸物件の内見日程の調整', assignee: '岡田', status: '未処理',
    due_date: today, sender: 'sato.m@example.com', subject: '内見希望日について（佐藤）',
    body_preview: 'お世話になっております。先日問い合わせいたしました物件について、今週の木曜か金曜の午後に内見をお願いできますでしょうか。よろしくお願いいたします。',
    classification_note: '賃貸物件の内見日程調整の依頼。物件管理の担当である岡田さんに割り当てました。当日中の返信が望ましいため期限を本日に設定。',
    sender_display: '佐藤様', sender_email: 'sato.m@example.com',
    source: 'email', received_at: h(4), created_at: h(4), updated_at: h(4),
  },
  {
    id: 't3', gmail_thread_id: 'th3', gmail_message_id: 'm3',
    title: '10:00 定例ミーティング（会議室A）', assignee: '橋口', status: '未処理',
    due_date: today, sender: 'calendar', subject: '定例ミーティング',
    body_preview: '月次の進捗共有。資料は共有フォルダを参照。\n担当：橋口',
    classification_note: 'カレンダー「栄和共通」の当日イベントから自動登録。詳細に「担当：橋口」の記載があるため橋口さんに割り当てました。',
    sender_display: 'Googleカレンダー', sender_email: null,
    source: 'calendar', received_at: h(6), created_at: h(6), updated_at: h(6),
  },
  {
    id: 't4', gmail_thread_id: 'th4', gmail_message_id: 'm4',
    title: '請求書の再発行依頼への返信', assignee: '西川', status: '返信済み',
    due_date: null, sender: 'keiri@midori-shoji.example.jp', subject: '請求書再発行のお願い',
    body_preview: '（返信内容）ミドリ商事 経理ご担当者様　お世話になっております。ご依頼の請求書を再発行し、本メールに添付いたしました。ご確認のほどよろしくお願いいたします。',
    classification_note: '請求書の再発行依頼。経理関連は西川さんの担当。/// 自社ドメインからの返信を検知したため「返信済み」に自動変更しました。',
    sender_display: 'ミドリ商事 経理部', sender_email: 'keiri@midori-shoji.example.jp',
    source: 'email', received_at: h(26), created_at: h(26), updated_at: h(1),
  },
  {
    id: 't5', gmail_thread_id: 'th5', gmail_message_id: 'm5',
    title: '駐車場契約の名義変更手続き', assignee: '岡田', status: '対応中',
    due_date: null, sender: 'suzuki.k@example.net', subject: '駐車場契約の名義変更について',
    body_preview: '会社名義から個人名義への変更を希望しています。必要な書類と手続きの流れを教えてください。',
    classification_note: '駐車場契約の手続きに関する問い合わせ。契約管理の担当である岡田さんに割り当てました。',
    sender_display: '鈴木様', sender_email: 'suzuki.k@example.net',
    source: 'email', received_at: h(30), created_at: h(30), updated_at: h(5),
  },
  {
    id: 't6', gmail_thread_id: 'th6', gmail_message_id: 'm6',
    title: 'ホームページの掲載内容修正依頼', assignee: '橋口', status: '対応中',
    due_date: null, sender: 'info@aozora-planning.example.jp', subject: 'HP掲載情報の修正のお願い',
    body_preview: '営業時間の表記が旧のままになっておりますので、修正をお願いいたします。',
    classification_note: 'ホームページ運用に関する修正依頼。Web担当の橋口さんに割り当てました。',
    sender_display: 'アオゾラ企画 様', sender_email: 'info@aozora-planning.example.jp',
    source: 'email', received_at: h(50), created_at: h(50), updated_at: h(8),
  },
  {
    id: 't7', gmail_thread_id: 'th7', gmail_message_id: 'm7',
    title: '設備点検の報告書送付', assignee: '西川', status: '完了',
    due_date: null, sender: 'hokoku@tenken-service.example.co.jp', subject: '【報告】定期設備点検の結果について',
    body_preview: '先日実施いたしました定期設備点検の報告書をお送りいたします。特に異常はありませんでした。',
    classification_note: '定期点検の報告書受領。確認のみで完了できる案件として西川さんに割り当てました。',
    sender_display: '点検サービス株式会社', sender_email: 'hokoku@tenken-service.example.co.jp',
    source: 'email', received_at: h(75), created_at: h(75), updated_at: h(24),
  },
  {
    id: 't8', gmail_thread_id: 'th8', gmail_message_id: 'm8',
    title: '共用部の電球交換の手配', assignee: '岡田', status: '完了',
    due_date: null, sender: 'kanri@heights-sakura.example.jp', subject: '共用廊下の照明について',
    body_preview: '2階共用廊下の照明が切れています。交換の手配をお願いします。',
    classification_note: '共用部の設備対応依頼。物件管理の担当である岡田さんに割り当てました。',
    sender_display: 'ハイツさくら 管理人', sender_email: 'kanri@heights-sakura.example.jp',
    source: 'email', received_at: h(100), created_at: h(100), updated_at: h(48),
  },
]

const settings = [
  { key: 'fetch_interval_minutes', value: '30' },
  { key: 'active_hours_start', value: '8' },
  { key: 'active_hours_end', value: '18' },
  { key: 'assignees', value: '西川,岡田,橋口' },
  { key: 'business_keywords', value: '見積,契約,請求,内見,点検' },
  { key: 'org_context', value: '不動産管理会社。\n- 見積・請求・経理関連 → 西川\n- 物件管理・入居者対応・契約手続き → 岡田\n- Web・広報・イベント → 橋口\n- 広告・宣伝メールはタスク化しない' },
  { key: 'shared_gmail', value: 'eiwa.public@gmail.com' },
  { key: 'company_domains', value: 'eiwa-up.jp' },
  { key: 'calendar_name', value: 'eiwa.public@gmail.com' },
]

const logs = [
  { id: 'l1', log_type: 'fetch', actor: 'システム（自動）', message: 'メール取得: 3件中 2件をタスク登録（スキップ1件）/ カレンダー登録 1件', created_at: h(1) },
  { id: 'l2', log_type: 'status_change', actor: 'システム（自動）', message: '「請求書の再発行依頼への返信」のステータスを 未処理 → 返信済み に変更（返信を検知）', created_at: h(1) },
  { id: 'l3', log_type: 'status_change', actor: '岡田', message: '「駐車場契約の名義変更手続き」のステータスを 未処理 → 対応中 に変更', created_at: h(5) },
  { id: 'l4', log_type: 'fetch', actor: '西川', message: 'メール取得: 5件中 3件をタスク登録（スキップ2件）', created_at: h(9) },
]

const usage = { month: new Date(now).toISOString().slice(0, 7), input_tokens: 182000, output_tokens: 21500, calls: 96, updated_at: h(1) }

const fakeJwt = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', username: 'nishikawa', display_name: '西川', exp: Math.floor(now / 1000) + 86400 })}.x`
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname
  let body = ''
  for await (const chunk of req) body += chunk

  if (path === '/api/login' && req.method === 'POST') {
    return json(res, { token: fakeJwt(), user: { id: 'u1', username: 'nishikawa', display_name: '西川' } })
  }
  if (path === '/api/run-fetch') {
    // デモ演出: 取得実行で t1 の返信が検知され「返信済み」へ自動移動する
    const t1 = tasks.find((t) => t.id === 't1')
    if (t1 && t1.status === '未処理') {
      t1.status = '返信済み'
      t1.updated_at = new Date().toISOString()
    }
    return json(res, { fetched: 3, created: 0, replied: 1, nonBusiness: 2, calendarCreated: 0 })
  }
  if (path === '/demo/reset') {
    const st = { t1: '未処理', t2: '未処理', t3: '未処理', t4: '返信済み', t5: '対応中', t6: '対応中', t7: '完了', t8: '完了' }
    for (const t of tasks) t.status = st[t.id]
    return json(res, { ok: true })
  }
  if (path === '/api/settings') return json(res, { ok: true })

  if (path.startsWith('/rest/v1/')) {
    const table = path.slice('/rest/v1/'.length)
    const single = (req.headers.accept || '').includes('pgrst.object')
    if (table === 'tasks' && req.method === 'GET') return json(res, tasks)
    if (table === 'tasks' && req.method === 'PATCH') {
      const id = (url.searchParams.get('id') || '').replace('eq.', '')
      const patch = JSON.parse(body || '{}')
      const t = tasks.find((t) => t.id === id)
      if (t) Object.assign(t, patch, { updated_at: new Date().toISOString() })
      res.writeHead(204); return res.end()
    }
    if (table === 'activity_logs' && req.method === 'GET') return json(res, logs)
    if (table === 'activity_logs' && req.method === 'POST') {
      const row = JSON.parse(body || '{}')
      logs.unshift({ id: 'l' + (logs.length + 1), created_at: new Date().toISOString(), ...row })
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('[]')
    }
    if (table === 'settings') return json(res, settings)
    if (table === 'api_usage') return json(res, single ? usage : [usage])
    return json(res, single ? null : [])
  }

  // 静的配信（SPA フォールバック）
  let file = join(DIST, path === '/' ? 'index.html' : path)
  if (!existsSync(file)) file = join(DIST, 'index.html')
  try {
    const data = readFileSync(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('not found')
  }
}).listen(PORT, () => console.log(`mock server on http://localhost:${PORT}`))
