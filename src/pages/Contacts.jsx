import { useCallback, useEffect, useMemo, useState } from 'react'
import AppHeader from '../components/AppHeader'
import FeatureHeader from '../components/FeatureHeader'
import ContactForm from '../components/ContactForm'
import { IconSearch, IconPhone, IconMail, IconGlobe } from '../components/Icons'
import { fetchContacts, fetchContactCategories, syncContactsFromTasks, buildContactMailto } from '../lib/contacts'
import { fetchSettings } from '../lib/tasks'
import './Dashboard.css'
import './Contacts.css'

const DEFAULT_ASSIGNEES = ['橋口', '西川', '岡田']

function parseAssignees(raw) {
  if (!raw) return DEFAULT_ASSIGNEES
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_ASSIGNEES
  } catch {
    return DEFAULT_ASSIGNEES
  }
}

// 連絡帳（顧客の連絡先台帳。2026-08-31〜）。タスク・メールの取得実績から自動作成でき、
// 一覧からの検索・修正にも対応する。会社電話・携帯電話は tel:、メールTOは mailto:
// （登録済みのCCを自動付与）のリンクをそれぞれ持つ。
export default function Contacts() {
  const [contacts, setContacts] = useState([])
  const [categories, setCategories] = useState([])
  const [assignees, setAssignees] = useState(DEFAULT_ASSIGNEES)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [editingContact, setEditingContact] = useState(null) // null | 'new' | contact

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [contactsData, categoriesData, settings] = await Promise.all([
        fetchContacts(),
        fetchContactCategories(),
        fetchSettings(),
      ])
      setContacts(contactsData)
      setCategories(categoriesData)
      setAssignees(parseAssignees(settings.assignees))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function handleToggleSearch() {
    if (searchOpen) {
      setSearchOpen(false)
      setQuery('')
    } else {
      setSearchOpen(true)
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError('')
    setInfo('')
    try {
      const result = await syncContactsFromTasks()
      setInfo(
        result.created > 0
          ? `${result.created}件の連絡先を自動作成しました。`
          : '新たに作成できる連絡先はありませんでした（登録済みのものはタスク・メールの実績で上書きしません）。'
      )
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSyncing(false)
    }
  }

  function handleSaved() {
    setEditingContact(null)
    load()
  }

  function handleDeleted() {
    setEditingContact(null)
    load()
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) =>
      [c.company_name, c.business_category, c.contact_person, c.staff_name, c.email_to]
        .filter(Boolean)
        .some((s) => s.toLowerCase().includes(q))
    )
  }, [contacts, query])

  return (
    <div className="ui-page">
      <AppHeader />
      <div className="ui-container is-narrow app-scroll">
        <FeatureHeader
          actions={
            <>
              <button type="button" className="btn-plain" onClick={handleSync} disabled={syncing}>
                {syncing ? '作成中…' : '連絡帳を自動作成'}
              </button>
              <button
                type="button"
                className={`icon-btn-search${searchOpen ? ' is-active' : ''}`}
                onClick={handleToggleSearch}
                aria-label="会社名・担当者名などで検索"
                aria-pressed={searchOpen}
                title="会社名・担当者名などで検索"
              >
                <IconSearch size={20} />
              </button>
              <button type="button" className="btn-primary" onClick={() => setEditingContact('new')}>
                連絡先を追加
              </button>
            </>
          }
        >
          {searchOpen && (
            <div className="reports-search-bar">
              <IconSearch size={18} />
              <input
                type="search"
                className="reports-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="会社名・担当者名などで検索"
                aria-label="会社名・担当者名などで検索"
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
        </FeatureHeader>

        {error && (
          <p className="dashboard-error dashboard-banner" role="alert">
            {error}
          </p>
        )}
        {info && <p className="dashboard-banner">{info}</p>}

        {loading ? (
          <p className="dashboard-loading">読み込み中…</p>
        ) : filtered.length === 0 ? (
          <p className="ui-empty">
            {contacts.length === 0 ? '連絡先がまだ登録されていません。' : '該当する連絡先が見つかりません。'}
          </p>
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <thead>
                <tr>
                  <th>会社名</th>
                  <th>業務分類</th>
                  <th>顧客担当者名</th>
                  <th>主担当者</th>
                  <th>連絡先</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => {
                  const mailto = buildContactMailto(c)
                  return (
                    <tr key={c.id} className="contact-row" onClick={() => setEditingContact(c)}>
                      <td>{c.company_name}</td>
                      <td>{c.business_category || ''}</td>
                      <td>{c.contact_person || ''}</td>
                      <td>{c.staff_name || ''}</td>
                      <td className="contact-actions-cell" onClick={(e) => e.stopPropagation()}>
                        {c.company_phone && (
                          <a
                            className="icon-btn-phone"
                            href={`tel:${c.company_phone}`}
                            aria-label={`会社に電話（${c.company_phone}）`}
                            title={`会社に電話（${c.company_phone}）`}
                          >
                            <IconPhone size={18} />
                          </a>
                        )}
                        {c.mobile_phone && (
                          <a
                            className="icon-btn-phone"
                            href={`tel:${c.mobile_phone}`}
                            aria-label={`携帯に電話（${c.mobile_phone}）`}
                            title={`携帯に電話（${c.mobile_phone}）`}
                          >
                            <IconPhone size={18} />
                          </a>
                        )}
                        {mailto && (
                          <a
                            className="icon-btn-mail"
                            href={mailto}
                            aria-label={`メールを作成（${c.email_to}）`}
                            title={`メールを作成（${c.email_to}）`}
                          >
                            <IconMail size={18} />
                          </a>
                        )}
                        {c.website_url && (
                          <a
                            className="icon-btn-globe"
                            href={c.website_url}
                            target="_blank"
                            rel="noreferrer"
                            aria-label="ホームページを開く"
                            title="ホームページを開く"
                          >
                            <IconGlobe size={18} />
                          </a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editingContact && (
        <ContactForm
          key={editingContact === 'new' ? 'new' : editingContact.id}
          existing={editingContact === 'new' ? null : editingContact}
          categories={categories}
          assignees={assignees}
          onClose={() => setEditingContact(null)}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
