// 検針管理: FileMaker「検針記録」から書き出した CSV（テーブル単位）の読み取り（2026-10-20〜。
// docs/meter-plan.md 4章・8章 Phase 1）。
//
// FileMaker の書き出しは UTF-8（BOM付き）・改行は CR のみ・1行目が項目名。どのテーブルの CSV かは
// 項目名で見分けるので、ファイル名や選ぶ順番は問わない。ここは画面（取込）と検証スクリプト
// （scripts/verify-meter-output.mjs）の両方から使うため、DOM やブラウザ固有の API には頼らない。

// 1つの CSV テキストを行の配列にする（ダブルクォート内の改行・カンマ・"" に対応）
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

// 項目名の行から、どのテーブルの CSV かを見分ける
const KIND_SIGNATURES = [
  { kind: 'tenants', label: 'テナントマスタ', must: ['請求先コード', '正式名称', '入居年月日'] },
  { kind: 'meters', label: 'メータマスタ', must: ['メータ番号', 'テナント内連番', 'メーター桁数'] },
  { kind: 'readings', label: '検針データ', must: ['検針月度', 'メーター値', 'メーター値_差分'] },
  { kind: 'ac_units', label: '空調機マスタ', must: ['空調機番号', 'アドレス番号', '割当てメータ番号'] },
  { kind: 'ac_usage', label: '空調データ', must: ['空調機番号', '昼間電力使用量', '年月度'] },
]

export const MIGRATION_FILES = KIND_SIGNATURES.map(({ kind, label }) => ({ kind, label }))

export function detectCsvKind(header) {
  const set = new Set(header.map((h) => h.trim()))
  // 空調データは空調機マスタの項目も含むので、項目の多い方から順に当てる
  const order = ['readings', 'ac_usage', 'tenants', 'meters', 'ac_units']
  for (const kind of order) {
    const sig = KIND_SIGNATURES.find((s) => s.kind === kind)
    if (sig.must.every((m) => set.has(m))) return kind
  }
  return null
}

// ---------- 値の変換 ----------

function str(value) {
  if (value == null) return null
  // FileMaker の改行（垂直タブ）は改行に直す
  const t = String(value).replaceAll('\v', '\n').trim()
  return t === '' ? null : t
}

function num(value) {
  const t = str(value)
  if (t == null) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function int(value) {
  const n = num(value)
  return n == null ? null : Math.trunc(n)
}

function flag(value) {
  const n = num(value)
  return n != null && n !== 0
}

// '2026/10/01'・'2026/3/16'・'1900.01.01' → '2026-10-01'
export function fmDate(value) {
  const t = str(value)
  if (!t) return null
  const m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(t)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

// '9:36:23' → '09:36:23'
export function fmTime(value) {
  const t = str(value)
  if (!t) return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (!m) return null
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`
}

// '2026/10/19 9:36:23'（日本時間）→ ISO 文字列
export function fmTimestamp(value) {
  const t = str(value)
  if (!t) return null
  const [d, tm] = t.split(/\s+/)
  const date = fmDate(d)
  const time = fmTime(tm || '0:00:00')
  return date && time ? `${date}T${time}+09:00` : null
}

// '2026年10月'・'2026年 9月' → '2026-09'
export function fmMonth(value) {
  const t = str(value)
  if (!t) return null
  const m = /^(\d{4})年\s*(\d{1,2})月$/.exec(t)
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null
}

function rowObjects(rows) {
  const [header, ...body] = rows
  const keys = header.map((h) => h.trim())
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])))
}

// ---------- テーブルごとの変換（DB の列名に合わせる） ----------

export function mapTenants(rows) {
  return rowObjects(rows).map((r) => {
    const emergency = [1, 2, 3]
      .map((n) => ({
        name: str(r[`緊急連絡先氏名 ${n}`]),
        kana: str(r[`緊急連絡先氏名フリガナ ${n}`]),
        phone: str(r[`緊急連絡先電話番号 ${n}`]),
        mobile: str(r[`緊急連絡先携帯番号 ${n}`]),
      }))
      .filter((c) => c.name || c.kana || c.phone || c.mobile)
    const profile = {
      security_block: str(r['セイキュリティブロック']),
      representative: str(r['代表者名']),
      phone: str(r['代表電話番号']),
      email: str(r['連絡先メールアドレス']),
      usage: str(r['用途']),
      capacity: int(r['収容人数']),
      fire_manager: str(r['火元責任者']),
      fire_manager_title: str(r['火元責任者職名']),
      fire_manager_appointed_on: fmDate(r['火元責任者選任日付']),
      fire_manager_note: str(r['火元責任者補足情報']),
      emergency_contacts: emergency,
      legacy_tenant_code: str(r['テナントコード_未使用']),
      fix_note: str(r['修正に関する備考']),
    }
    for (const key of Object.keys(profile)) {
      if (profile[key] == null || (Array.isArray(profile[key]) && profile[key].length === 0)) delete profile[key]
    }
    return {
      legacy_id: str(r['主キー']),
      billing_code: str(r['請求先コード']),
      name: str(r['正式名称']),
      short_name: str(r['略称']),
      floor: str(r['階']),
      note: str(r['検針に関する備考']),
      moved_out: flag(r['退去済み']),
      moved_in_on: fmDate(r['入居年月日']),
      first_month_billable: flag(r['初月無料にしない']),
      profile,
    }
  })
}

const METER_KINDS = new Set(['電気', 'ガス', '水道'])

export function mapMeters(rows) {
  return rowObjects(rows).map((r) => ({
    legacy_id: str(r['主キー']),
    meter_no: str(r['メータ番号']),
    room_no: str(r['部屋番号']),
    billing_code: str(r['請求先コード']),
    seq: int(r['テナント内連番']),
    floor: str(r['階']),
    room_name: str(r['貸室名']),
    seal_label: str(r['メータシール表記']),
    detail_note: str(r['請求明細補足']),
    kind: METER_KINDS.has(str(r['検針内容'])) ? str(r['検針内容']) : null,
    sort_order: int(r['表示順']),
    digits: int(r['メーター桁数']),
    max_value: int(r['メーター最大値']),
    expires_on: fmDate(r['メータ有効期限']),
    measured: flag(r['flg_メーター計測対象']),
    removed: flag(r['検針機撤去済み']),
    area_m2: num(r['部屋面積_m2']),
    area_tsubo: num(r['部屋面積_坪']),
    oa_share: flag(r['外調機電気量の按分有無']),
    oa_ratio: num(r['外調機電気量の按分比率']),
    is_oa_meter: flag(r['flg_外調機メータ']),
    note: str(r['備考']),
    created_at: fmTimestamp(r['作成情報タイムスタンプ']),
  }))
}

export function mapReadings(rows) {
  return rowObjects(rows).map((r) => ({
    legacy_id: str(r['主キー']),
    meter_no: str(r['メータ番号']),
    month: fmMonth(r['検針月度']),
    read_on: fmDate(r['検針日付']),
    read_time: fmTime(r['検針時刻']),
    value: num(r['メーター値']),
    value2: num(r['メーター値_2']),
    prev_override: num(r['メーター値_前月の修正']),
    diff_override: num(r['メータ値の修正差分値']),
    legacy_prev: num(r['メーター値_前月']),
    legacy_prev2: num(r['メーター値_前月_2']),
    legacy_diff: num(r['メーター値_差分']),
    legacy_diff2: num(r['メーター値_差分_2']),
    billing_code: str(r['請求先コード']),
    note: str(r['備考']),
    recorded_by: str(r['記録者氏名']),
    created_at: fmTimestamp(r['作成情報タイムスタンプ']),
  }))
}

export function mapAcUnits(rows) {
  return rowObjects(rows).map((r) => ({
    unit_no: int(r['空調機番号']),
    address: str(r['アドレス番号']),
    meter_no: str(r['割当てメータ番号']),
  }))
}

export function mapAcUsage(rows) {
  return rowObjects(rows).map((r) => ({
    month: fmMonth(r['年月度']),
    unit_no: int(r['空調機番号']),
    address: str(r['室内機名称']),
    hp_code: str(r['馬力コード']),
    day_wh: int(r['昼間電力使用量']),
    night_wh: int(r['夜間電力使用量']),
    day_stop_wh: int(r['昼間停止時の電力量']),
    night_stop_wh: int(r['夜間停止時の電力量']),
    gas: int(r['ガス使用量']),
    meter_no: str(r['割当て先メータ番号']),
  }))
}

const MAPPERS = {
  tenants: mapTenants,
  meters: mapMeters,
  readings: mapReadings,
  ac_units: mapAcUnits,
  ac_usage: mapAcUsage,
}

// CSV テキスト1本を読み、{ kind, label, records } を返す。見分けられなければ例外
export function readMigrationCsv(text) {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error('中身が空です')
  const kind = detectCsvKind(rows[0])
  if (!kind) throw new Error('FileMaker のどのテーブルの CSV か見分けられませんでした（項目名の行が必要です）')
  const label = KIND_SIGNATURES.find((s) => s.kind === kind).label
  return { kind, label, records: MAPPERS[kind](rows) }
}

// ---------- 空調集中コントローラの CSV（Phase 3 で取込画面に使う。2026-10-20 に原本で形式を確認） ----------
// Shift_JIS・CRLF。1行目「開始日,日数,…」、2行目にその値、空行、4行目が室内機の項目名、以下1台1行。
// 昼間電力使用量（Wh）だけを使う。年月度は「開始日の翌月」（9/1〜9/30 の使用分＝10月度）
export function parseAcControllerCsv(text) {
  const rows = parseCsv(text)
  const headIdx = rows.findIndex((r) => r[0]?.trim() === '開始日')
  const unitIdx = rows.findIndex((r) => r[0]?.trim() === '空調機番号')
  if (headIdx < 0 || unitIdx < 0) throw new Error('空調集中コントローラの CSV の形式ではありません')
  const start = /^(\d{4})(\d{2})(\d{2})$/.exec(rows[headIdx + 1]?.[0]?.trim() || '')
  if (!start) throw new Error('開始日を読み取れませんでした')
  const periodStart = `${start[1]}-${start[2]}-${start[3]}`
  const days = int(rows[headIdx + 1]?.[1])
  const y = Number(start[1])
  const m = Number(start[2])
  const month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  const units = rows
    .slice(unitIdx + 1)
    .filter((r) => /^\d+$/.test(r[0]?.trim() || ''))
    .map((r) => ({
      unit_no: int(r[0]),
      address: str(r[1]),
      hp_code: str(r[2]),
      day_wh: int(r[3]),
      night_wh: int(r[4]),
      day_stop_wh: int(r[5]),
      night_stop_wh: int(r[6]),
      gas: int(r[7]),
    }))
  return { month, periodStart, days, units }
}
