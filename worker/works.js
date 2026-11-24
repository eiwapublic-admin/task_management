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
import { handleActuals, handleActualsPlan } from './lib/works/actuals.js'
import { handleLeave, handleLeaveDecide, handleLeaveMine, handleLeaveRequests } from './lib/works/leave.js'
import { handleAlertCount, handleAlertResolve, handleAlerts, runAlertNotifications } from './lib/works/alerts.js'
import { handlePushKey, handlePushSubscribe, handlePushUnsubscribe } from './lib/works/push.js'
import { handlePunchRequestDecide, handlePunchRequests } from './lib/works/requests.js'
import { jstParts } from './lib/works/time.js'
import { handlePunch, handlePunches, handlePunchProxy, handlePunchSelf, handlePunchToday, handleSiteQr } from './lib/works/punches.js'

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
      if (pathname === '/api/works/leave') return await handleLeave(req)
      if (pathname === '/api/works/leave/mine') return await handleLeaveMine(req)
      if (pathname === '/api/works/leave/requests') return await handleLeaveRequests(req)
      if (pathname === '/api/works/punch/today') return await handlePunchToday(req)
      if (pathname === '/api/works/punches') return await handlePunches(req)
      if (pathname === '/api/works/alerts') return await handleAlerts(req)
      if (pathname === '/api/works/alerts/count') return await handleAlertCount(req)
      if (pathname === '/api/works/punch-requests') return await handlePunchRequests(req)
      if (pathname === '/api/works/push/key') return await handlePushKey(req)
      const POST_ONLY = { '/api/works/actuals': handleActuals, '/api/works/actuals/plan': handleActualsPlan, '/api/works/leave/requests/decide': handleLeaveDecide, '/api/works/punch': handlePunch, '/api/works/punch/proxy': handlePunchProxy, '/api/works/punch/self': handlePunchSelf, '/api/works/sites/qr': handleSiteQr, '/api/works/alerts/resolve': handleAlertResolve, '/api/works/punch-requests/decide': handlePunchRequestDecide, '/api/works/push/subscribe': handlePushSubscribe, '/api/works/push/unsubscribe': handlePushUnsubscribe }
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
  // 5 分おき（Cron は 1 本だけ使う。無料枠は 5 本）。
  //   ・未出勤・退勤漏れの通知（docs/eworks-plan.md 8-3・13-1）
  //   ・日本時間 0:00〜0:04 の回だけ、設定の「予定を作る日」になったら翌月の予定を作る（7-2）
  async scheduled(event, _env, ctx) {
    const now = new Date(event.scheduledTime || Date.now())
    const { time } = jstParts(now)
    if (time < '00:05') {
      ctx.waitUntil(
        autoCreateNextMonth()
          .then((r) => r && console.log('works 予定の自動作成:', JSON.stringify({ month: r.month, created: r.created.length, skipped: r.skipped.length })))
          .catch((err) => console.error('works 予定の自動作成に失敗:', err))
      )
    }
    ctx.waitUntil(
      runAlertNotifications(now)
        .then((r) => r?.sent && console.log('works 要確認の通知:', r.sent))
        .catch((err) => console.error('works 要確認の通知に失敗:', err))
    )
  },
}
