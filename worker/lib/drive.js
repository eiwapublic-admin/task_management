// Google Drive API を fetch で直接叩く軽量クライアント（追加依存なし。2026-09-30〜）。
// 廃棄物実測集計表をGoogleドライブから直接取り込むために使う（docs/waste-plan.md 10-7）。
// Gmail と同じ OAuth アクセストークンを使う（スコープに drive.readonly が必要。
// docs/google-oauth-scope-update.md 4章）。

const API_BASE = 'https://www.googleapis.com/drive/v3'

export const DRIVE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function driveFetch(accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`Google Drive API エラー (${res.status}) ${path}: ${text}`)
    // 403 は「スコープ不足」と「Drive API がプロジェクトで未有効」の2通りがあり、
    // 利用者への案内（トークン再発行か、APIの有効化か）が異なるため区別する
    if (res.status === 401 || res.status === 403) {
      if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(text)) err.isApiDisabled = true
      else err.isScopeError = true
    }
    if (res.status === 404) err.isNotFound = true
    throw err
  }
  return res
}

// 名前に keyword を含むスプレッドシート（Googleスプレッドシート・.xlsx）を、
// 更新日時の新しい順に返す。ゴミ箱の中のファイルは除く。
export async function searchSpreadsheets(accessToken, keyword, limit = 20) {
  const escaped = keyword.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const params = new URLSearchParams({
    q: `name contains '${escaped}' and trashed = false and (mimeType = '${DRIVE_SHEET_MIME}' or mimeType = '${XLSX_MIME}')`,
    orderBy: 'modifiedTime desc',
    pageSize: String(limit),
    fields: 'files(id,name,mimeType,modifiedTime)',
    spaces: 'drive',
  })
  const res = await driveFetch(accessToken, `/files?${params}`)
  const data = await res.json()
  return data.files || []
}

export async function getFileMetadata(accessToken, fileId) {
  const res = await driveFetch(
    accessToken,
    `/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent('id,name,mimeType,size,trashed')}`
  )
  return res.json()
}

// ファイルの中身を .xlsx として返す。Googleスプレッドシートは .xlsx に書き出し、
// .xlsx はそのままダウンロードする（どちらもブラウザ側の同じパーサーで読めるようにするため）。
export async function downloadAsXlsx(accessToken, file) {
  const id = encodeURIComponent(file.id)
  const path =
    file.mimeType === DRIVE_SHEET_MIME
      ? `/files/${id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
      : `/files/${id}?alt=media`
  const res = await driveFetch(accessToken, path)
  return res.arrayBuffer()
}
