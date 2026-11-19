// 勤怠管理（eWorks）の Worker（入口）。docs/eworks-plan.md 5-1
//
// タスク管理（worker/index.js）とは別の Worker として公開し、/api/works/* だけを持つ。
// 現場スタッフ（role='field_staff'）にタスク管理の API・画面を見せないための分離。
// データベース・ログイン ID・JWT の署名鍵は共通。
import { json, withSecurityHeaders } from './lib/http.js'
import { handleWorksLogin, handleWorksMe } from './lib/works/auth.js'
import { handleMaster, handleSchedules, handleSettings } from './lib/works/masters.js'
import { handleInviteAccept, handleInviteCheck, handleInvites } from './lib/works/invites.js'
import { autoCreateNextMonth, handleGenerate, handleShifts } from './lib/works/plans.js'
import { handlePunch, handlePunches, handlePunchProxy, handlePunchToday, handleSiteQr } from './lib/works/punches.js'

const MASTER_TABLES = {
  '/api/works/staff': 'works_staff',
  '/api/works/patterns': 'works_shift_patterns',
  '/api/works/sites': 'works_sites',
}

async function route(req, env) {
  const { pathname } = new URL(req.url)

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/works/login') {
        return req.method === 'POST' ? await handleWorksLogin(req, env) : json({ error: 'Method Not Allowed' }, 405)
      }
      if (pathname === '/api/works/me') return await handleWorksMe(req)
      if (MASTER_TABLES[pathname]) return await handleMaster(req, MASTER_TABLES[pathname])
      if (pathname === '/api/works/schedules') return await handleSchedules(req)
      if (pathname === '/api/works/settings') return await handleSettings(req)
      if (pathname === '/api/works/invites') return await handleInvites(req)
      if (pathname === '/api/works/shifts') return await handleShifts(req)
      if (pathname === '/api/works/shifts/generate') {
        return req.method === 'POST' ? await handleGenerate(req) : json({ error: 'Method Not Allowed' }, 405)
      }
      if (pathname === '/api/works/punch/today') return await handlePunchToday(req)
      if (pathname === '/api/works/punches') return await handlePunches(req)
      const POST_ONLY = { '/api/works/punch': handlePunch, '/api/works/punch/proxy': handlePunchProxy, '/api/works/sites/qr': handleSiteQr }
      if (POST_ONLY[pathname]) return req.method === 'POST' ? await POST_ONLY[pathname](req) : json({ error: 'Method Not Allowed' }, 405)
      if (pathname === '/api/works/invite/check') {
        return req.method === 'POST' ? await handleInviteCheck(req, env) : json({ error: 'Method Not Allowed' }, 405)
      }
      if (pathname === '/api/works/invite/accept') {
        return req.method === 'POST' ? await handleInviteAccept(req, env) : json({ error: 'Method Not Allowed' }, 405)
      }
    } catch (err) {
      console.error('works api 失敗:', pathname, err)
      return json({ error: '処理に失敗しました' }, 500)
    }
    return json({ error: 'Not Found' }, 404)
  }

  // 静的アセット（SPA）。index.html と sw.js は更新が届くようキャッシュさせない（worker/index.js と同じ理由）
  const assetRes = await env.ASSETS.fetch(req)
  if (pathname === '/sw.js' || (assetRes.headers.get('content-type') || '').startsWith('text/html')) {
    const headers = new Headers(assetRes.headers)
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
    return new Response(assetRes.body, { status: assetRes.status, statusText: assetRes.statusText, headers })
  }
  return assetRes
}

export default {
  async fetch(req, env) {
    return withSecurityHeaders(await route(req, env))
  },
  // 毎日 0:00（日本時間）。設定の「予定を作る日」になったら翌月の予定を作る（docs/eworks-plan.md 7-2）
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(
      autoCreateNextMonth()
        .then((r) => r && console.log('works 予定の自動作成:', JSON.stringify({ month: r.month, created: r.created.length, skipped: r.skipped.length })))
        .catch((err) => console.error('works 予定の自動作成に失敗:', err))
    )
  },
}
