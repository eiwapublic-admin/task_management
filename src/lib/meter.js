import { authFetch } from './api'
import { getToken } from './auth'

// 検針管理（FileMaker「検針記録」の移植。2026-10-20〜）の API 呼び出し。docs/meter-plan.md

export function fetchMeterMasters() {
  return authFetch('/api/meter/masters')
}

// テナントマスタ（備品と共有）。社員だけ。基本情報（profile）を含む
export function fetchMeterTenants() {
  return authFetch('/api/meter/tenants').then((d) => d.tenants || [])
}

// id があれば修正、無ければ追加
export function saveMeterTenant(tenant) {
  return authFetch('/api/meter/tenants', {
    method: tenant.id ? 'PATCH' : 'POST',
    body: JSON.stringify(tenant),
  }).then((d) => d.tenant)
}

export function saveMeter(meter) {
  return authFetch('/api/meter/meters', {
    method: meter.id ? 'PATCH' : 'POST',
    body: JSON.stringify(meter),
  }).then((d) => d.meter)
}

export function updateMeterAcUnit(unitNo, meterId, reason = '') {
  return authFetch('/api/meter/ac-units', {
    method: 'PATCH',
    body: JSON.stringify({ unit_no: unitNo, meter_id: meterId || null, reason }),
  }).then((d) => d.unit)
}

export function saveMeterConstants(values) {
  return authFetch('/api/meter/constants', { method: 'PUT', body: JSON.stringify(values) }).then((d) => d.constants)
}

export function importMeterRecords(body) {
  return authFetch('/api/meter/import', { method: 'POST', body: JSON.stringify(body) })
}

export function fetchMeterOutputData(month) {
  return authFetch(`/api/meter/output?month=${encodeURIComponent(month)}`)
}

// 検針の階の並び（地下→1F〜7F）。空欄（共用エリアなど）は先頭
export const METER_FLOORS = ['B', '1', '2', '3', '4', '5', '6', '7']

export function floorLabel(floor) {
  if (!floor) return '階なし'
  return floor === 'B' ? 'B1F' : `${floor}F`
}

// テナントの基本情報（profile）の項目。画面の並び順
export const TENANT_PROFILE_FIELDS = [
  { key: 'security_block', label: 'セキュリティブロック' },
  { key: 'usage', label: '用途' },
  { key: 'capacity', label: '収容人数', type: 'number' },
  { key: 'representative', label: '代表者名' },
  { key: 'phone', label: '代表電話番号' },
  // 連絡先メールアドレスは案内メールの宛先にまとめた（2026-10-21）。データは残し、画面には出さない
  { key: 'email', label: '連絡先メールアドレス', hidden: true },
  { key: 'fire_manager', label: '火元責任者' },
  { key: 'fire_manager_title', label: '火元責任者の職名' },
  { key: 'fire_manager_appointed_on', label: '火元責任者の選任日', type: 'date' },
  { key: 'fire_manager_note', label: '火元責任者の補足' },
  // テナントコード（旧）はデータだけ残し、画面には出さない（2026-10-21）
  { key: 'legacy_tenant_code', label: 'テナントコード（旧）', hidden: true },
  // ここから4つはテナント一覧表・緊急連絡先一覧表（Excel 出力）の列（2026-10-21〜）。
  // 部屋番号は空なら旧テナントコード → メータの部屋番号の順で補う。会社電話番号は空なら代表電話番号
  { key: 'room_label', label: '部屋番号（一覧表）' },
  { key: 'plate_name', label: 'プレート表示名' },
  { key: 'company_phone', label: '会社電話番号' },
  { key: 'entry_date', label: '記入日', type: 'date' },
  { key: 'update_info', label: '更新情報（一覧表）', wide: true },
  { key: 'list_exclude', label: 'テナント一覧表・緊急連絡先一覧表に載せない', type: 'checkbox' },
  // セコムに出す緊急連絡先一覧表（PDF）の「最終変更日付」「最終変更事項」（2026-10-26〜）。入力画面では緊急連絡先の下に出す
  { key: 'contact_changed_on', label: '最終変更日付（連絡用）', type: 'date', contact: true },
  { key: 'contact_change_note', label: '最終変更事項（連絡用）', contact: true },
  // 修正に関する備考は、画面の最下部に横長で出す（2026-10-21）
  { key: 'fix_note', label: '修正に関する備考', wide: true },
]

// ---------- 月度の作業（Phase 2。2026-10-20〜） ----------

// 今開くべき検針月度。月初の検針はその月の月度、月の半ば以降（ガス・水道の検針）は翌月度
export function defaultMeterMonth(now = new Date()) {
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const next = now.getDate() > 10
  const total = y * 12 + (m - 1) + (next ? 1 : 0)
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}

// 'YYYY-MM' → 'YYYY年M月度'
export function meterMonthLabel(month) {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月度`
}

export function fetchMeterMonth(month) {
  return authFetch(`/api/meter/month?month=${encodeURIComponent(month)}`)
}

export function saveMeterReading(body) {
  return authFetch('/api/meter/readings', { method: 'POST', body: JSON.stringify(body) }).then((d) => d.reading)
}

// 写真を1枚送る。端末で読んだバーコードを一緒に渡すと、サーバーがメータへ割り当てる
export async function uploadMeterPhoto({ month, file, filename, barcode, takenAt, width, height }) {
  const form = new FormData()
  form.append('month', month)
  form.append('file', file, filename || 'meter.jpg')
  if (filename) form.append('filename', filename)
  if (barcode) form.append('barcode', barcode)
  if (takenAt) form.append('taken_at', takenAt)
  if (width) form.append('width', String(width))
  if (height) form.append('height', String(height))
  // 通信が固まったときに「送信中」のまま止まらないよう、45秒で打ち切る（日報の写真と同じ）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 45000)
  let res
  try {
    res = await fetch('/api/meter/photos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body: form,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('写真の送信がタイムアウトしました。通信環境をご確認ください')
    throw err
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '写真の保存に失敗しました')
  return data.photo
}

export function assignMeterPhoto(id, meterId) {
  return authFetch('/api/meter/photos', {
    method: 'PATCH',
    body: JSON.stringify({ id, meter_id: meterId || null }),
  }).then((d) => d.photo)
}

export function deleteMeterPhoto(id) {
  return authFetch(`/api/meter/photos?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// 写真の本体を Blob で取る（バケットは非公開なので必ずこの経路）。同じ写真は画面を移っても使い回す
const photoCache = new Map()
export function fetchMeterPhotoBlob(id) {
  if (!photoCache.has(id)) {
    const p = fetch(`/api/meter/photo?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    }).then((res) => {
      if (!res.ok) throw new Error('写真を取得できませんでした')
      return res.blob()
    })
    p.catch(() => photoCache.delete(id))
    photoCache.set(id, p)
  }
  return photoCache.get(id)
}

// メータごとに使う写真（同じメータに複数あれば撮影日時の新しい方）。{ meterId: photo }
export function latestPhotoByMeter(photos) {
  const out = {}
  for (const p of photos) {
    if (!p.meter_id) continue
    const cur = out[p.meter_id]
    if (!cur || (p.taken_at || p.created_at) >= (cur.taken_at || cur.created_at)) out[p.meter_id] = p
  }
  return out
}

// 検針する対象＝計測対象で、撤去済みでなく検針内容があるメータ（2026年10月度はちょうど54台で、
// FileMaker の検針値の件数と一致することを確かめた）
export function activeMeters(meters) {
  return meters.filter((m) => m.measured && !m.removed && m.kind)
}

// ダッシュボードの「検針」カード用（2026-10-20〜）
export function fetchMeterSummary() {
  return authFetch('/api/meter/summary')
}

// ---------- 検針マスタの変更履歴（2026-10-21〜） ----------

// table・key を渡すとその1件の履歴だけ（table: equipment_tenants / meters / meter_ac_units）
// since（YYYY-MM-DD）を渡すとその日以降の変更だけ
export function fetchMeterHistory({ table, key, limit, since } = {}) {
  const q = new URLSearchParams()
  if (table) q.set('table', table)
  if (key != null) q.set('key', String(key))
  if (since) q.set('since', since)
  if (limit) q.set('limit', String(limit))
  return authFetch(`/api/meter/history?${q}`).then((d) => d.history || [])
}

// テナントの項目名（変更履歴の表示と、緊急連絡先一覧表 PDF の更新情報で使う）
export const TENANT_FIELD_LABELS = {
  billing_code: '請求先コード',
  name: '正式名称',
  short_name: '略称',
  floor: '階',
  moved_in_on: '入居年月日',
  moved_out_on: '退去日',
  moved_out: '退去済み',
  first_month_billable: '初月無料にしない',
  notice_emails: '案内メールの宛先',
  note: '備考',
  profile: '基本情報',
  default_item_id: '既定の備品',
  source: '登録元',
}
export const TENANT_PROFILE_LABELS = Object.fromEntries([
  ...TENANT_PROFILE_FIELDS.map((f) => [f.key, f.label]),
  ['emergency_contacts', '緊急連絡先'],
])

export const HISTORY_CONFLICT_MESSAGE = 'この変更のあとでさらに変わっています'

export function revertMeterHistory(id, { force = false, reason = '' } = {}) {
  return authFetch('/api/meter/history/revert', { method: 'POST', body: JSON.stringify({ id, force, reason }) })
}

// 変更理由をあとから書く（空にすると消す）
export function saveMeterHistoryReason(id, reason) {
  return authFetch('/api/meter/history', { method: 'PATCH', body: JSON.stringify({ id, reason }) }).then((d) => d.item)
}

// 検針マスタ（テナント・メータ・空調機）を保存する直前に、変更理由（任意）をダイアログで聞く（2026-10-21〜）。
// キャンセルなら null（保存しない）。空のまま OK なら ''
export function askChangeReason(message = '変更理由を入力してください（任意。空のままでも保存できます）') {
  const r = window.prompt(message, '')
  return r == null ? null : r.trim()
}
