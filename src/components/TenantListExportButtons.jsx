import { useState } from 'react'
import { IconDownload } from './Icons'
import { TENANT_LIST_KINDS, exportTenantList } from '../lib/tenantListExport'

// テナント一覧表（Excel）の出力ボタン（2026-10-21〜。社員だけ。基本情報を含むため。緊急連絡先は隠した列グループに入る）
export default function TenantListExportButtons({ onError }) {
  const [busy, setBusy] = useState(null)

  async function run(kind) {
    setBusy(kind)
    onError?.('')
    try {
      await exportTenantList(kind)
    } catch (err) {
      onError?.(err.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {Object.entries(TENANT_LIST_KINDS).map(([kind, def]) => (
        <button
          key={kind}
          type="button"
          className="btn-plain"
          onClick={() => run(kind)}
          disabled={busy != null}
          title={`${def.label}（Excel）を出力`}
        >
          <IconDownload size={20} />
          <span className="btn-plain-label">{busy === kind ? '作成中…' : def.label}</span>
        </button>
      ))}
    </>
  )
}
