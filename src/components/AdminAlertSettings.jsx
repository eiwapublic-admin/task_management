import { useEffect, useState } from 'react'
import { fetchAdminAlerts, sendTestAlert } from '../lib/alerts'
import { saveSettings } from '../lib/api'

// 設定画面「管理者通知（警告・エラー）」（2026-11-25〜）。
// 処理ログに W（警告）・E（エラー）が記録されたとき、ここで選んだ人の端末へ通知する。
// 誰も選ばないときは、通知を受け取る設定にしている全員の端末へ送る（従来の通知と同じ）。
// 保存は画面上の「保存」ボタンとは別（チェックの変更はこの欄のボタンで保存する）。
export default function AdminAlertSettings() {
  const [users, setUsers] = useState(null)
  const [selected, setSelected] = useState([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchAdminAlerts({ withUsers: true })
      .then((r) => {
        setUsers(r.users || [])
        setSelected(r.selected || [])
      })
      .catch((err) => setMessage(err.message))
  }, [])

  function toggle(id) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
  }

  async function handleSave() {
    setBusy(true)
    setMessage('')
    try {
      await saveSettings({ admin_alert_user_ids: selected })
      setMessage('通知先を保存しました')
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    setBusy(true)
    setMessage('')
    try {
      const r = await sendTestAlert()
      setMessage(
        r.sent > 0
          ? `テスト通知を ${r.sent} 台の端末へ送りました`
          : '送れる端末がありません。通知先の人が、その端末のハンバーガーメニューで通知をオンにしてください'
      )
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-alert-settings">
      <h2>管理者通知（警告・エラー）</h2>
      <p className="settings-hint">
        処理ログに警告（W）・エラー（E）が記録されると、選んだ人の端末へ通知します。誰も選ばないときは、
        通知をオンにしている全員の端末へ送ります。
      </p>
      {users === null ? (
        !message && <p className="settings-hint">読み込み中…</p>
      ) : (
        <ul className="admin-alert-users">
          {users.map((u) => (
            <li key={u.id}>
              <label className="admin-alert-user">
                <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} />
                <span>{u.display_name}</span>
                <span className="admin-alert-devices">
                  {u.devices > 0 ? `通知オンの端末 ${u.devices} 台` : '通知オンの端末なし'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="admin-alert-actions">
        <button type="button" className="btn-plain" onClick={handleSave} disabled={busy || users === null}>
          通知先を保存
        </button>
        <button type="button" className="btn-plain" onClick={handleTest} disabled={busy}>
          テスト通知を送る
        </button>
      </div>
      {message && (
        <p className="settings-hint" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
