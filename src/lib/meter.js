import { authFetch } from './api'

// 検針管理（FileMaker「検針記録」の移植。2026-10-20〜）の API 呼び出し。docs/meter-plan.md

export function fetchMeterMasters() {
  return authFetch('/api/meter/masters')
}

export function updateMeterTenant(patch) {
  return authFetch('/api/meter/tenants', { method: 'PATCH', body: JSON.stringify(patch) }).then((d) => d.tenant)
}

export function saveMeter(meter) {
  return authFetch('/api/meter/meters', {
    method: meter.id ? 'PATCH' : 'POST',
    body: JSON.stringify(meter),
  }).then((d) => d.meter)
}

export function updateMeterAcUnit(unitNo, meterId) {
  return authFetch('/api/meter/ac-units', {
    method: 'PATCH',
    body: JSON.stringify({ unit_no: unitNo, meter_id: meterId || null }),
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
  { key: 'email', label: '連絡先メールアドレス' },
  { key: 'fire_manager', label: '火元責任者' },
  { key: 'fire_manager_title', label: '火元責任者の職名' },
  { key: 'fire_manager_appointed_on', label: '火元責任者の選任日', type: 'date' },
  { key: 'fire_manager_note', label: '火元責任者の補足' },
  { key: 'legacy_tenant_code', label: 'テナントコード（旧）' },
  { key: 'fix_note', label: '修正に関する備考' },
]
