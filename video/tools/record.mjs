// 台本カットごとの操作録画（webm 出力）
import { chromium } from 'playwright'
import { mkdirSync, renameSync } from 'node:fs'

const BASE = 'http://localhost:8788'
const OUT = './clips'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

// 疑似カーソル（録画にマウスを映すため）
const CURSOR_SCRIPT = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div')
    c.id = '__cursor'
    c.style.cssText = 'position:fixed;top:0;left:0;width:22px;height:22px;z-index:99999;pointer-events:none;transform:translate(-3px,-2px)'
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M5 2 L5 19 L9.5 15.5 L12.5 21.5 L15 20.2 L12 14.4 L18 14 Z" fill="black" stroke="white" stroke-width="1.4"/></svg>'
    document.body.appendChild(c)
    window.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px' }, true)
    window.addEventListener('mousedown', () => { c.style.transform = 'translate(-3px,-2px) scale(0.82)' }, true)
    window.addEventListener('mouseup', () => { c.style.transform = 'translate(-3px,-2px)' }, true)
  })
`

async function newRecPage(clipName) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
  })
  await context.addInitScript(CURSOR_SCRIPT)
  const page = await context.newPage()
  page._clipName = clipName
  page._context = context
  return page
}

async function finishClip(page) {
  const video = page.video()
  await page._context.close()
  const path = await video.path()
  renameSync(path, `${OUT}/${page._clipName}.webm`)
  console.log(`saved: ${page._clipName}.webm`)
}

// なめらかにマウスを要素中央へ移動
async function glide(page, selector, opts = {}) {
  const el = page.locator(selector).first()
  await el.waitFor({ state: 'visible' })
  const box = await el.boundingBox()
  const x = box.x + box.width * (opts.fx ?? 0.5)
  const y = box.y + box.height * (opts.fy ?? 0.5)
  await page.mouse.move(x, y, { steps: opts.steps ?? 40 })
  return { x, y }
}

async function glideClick(page, selector, opts = {}) {
  const { x, y } = await glide(page, selector, opts)
  await page.waitForTimeout(opts.beforeClick ?? 400)
  await page.mouse.click(x, y)
}

async function typeSlow(page, selector, text) {
  await glideClick(page, selector)
  await page.keyboard.type(text, { delay: 90 })
}

async function login(page) {
  await page.goto(BASE + '/')
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE + '/')
  await page.waitForSelector('input[type="password"]')
  await page.fill('input:not([type="password"])', 'nishikawa')
  await page.fill('input[type="password"]', 'demo-password')
  await Promise.all([page.waitForSelector('.kanban-board, [class*=kanban], main'), page.click('button[type="submit"]')])
  await page.waitForTimeout(1200)
}

const reset = () => fetch(BASE + '/demo/reset')

// ---- C2: カンバン全景（ゆっくり視線移動） ----
async function clipC2() {
  const page = await newRecPage('c2_kanban')
  await login(page)
  await page.mouse.move(200, 400)
  await page.waitForTimeout(800)
  await glide(page, 'text=システム保守契約の見積依頼への対応', { steps: 60 })
  await page.waitForTimeout(900)
  await glide(page, 'text=駐車場契約の名義変更手続き', { steps: 70 })
  await page.waitForTimeout(900)
  await glide(page, 'text=設備点検の報告書送付', { steps: 70 })
  await page.waitForTimeout(1200)
  await finishClip(page)
}

// ---- C4: ログイン → カンバン → 担当者フィルタ ----
async function clipC4() {
  const page = await newRecPage('c4_login')
  await page.goto(BASE + '/')
  await page.evaluate(() => localStorage.clear())
  await page.goto(BASE + '/')
  await page.waitForSelector('input[type="password"]')
  await page.waitForTimeout(800)
  await typeSlow(page, 'input:not([type="password"])', 'nishikawa')
  await typeSlow(page, 'input[type="password"]', 'password')
  await glideClick(page, 'button[type="submit"]')
  await page.waitForTimeout(1800)
  // 担当者フィルタで「岡田」→「すべて」
  await glideClick(page, 'button:has-text("岡田")')
  await page.waitForTimeout(1400)
  await glideClick(page, 'button:has-text("すべて")')
  await page.waitForTimeout(1400)
  await finishClip(page)
}

// ---- C5: タスク詳細（AI判定理由 → メール参照 → 返信） ----
async function clipC5() {
  const page = await newRecPage('c5_detail')
  await login(page)
  await glideClick(page, 'text=システム保守契約の見積依頼への対応')
  await page.waitForTimeout(1600)
  // AI判定の理由へ視線誘導
  await glide(page, '.task-detail-note', { steps: 50 })
  await page.waitForTimeout(2200)
  // メール参照ボタンへ
  await glide(page, 'a.task-action-btn:has-text("メール")', { steps: 45 })
  await page.waitForTimeout(1600)
  // 返信ボタンへ（mailto は起動しないがクリック演出）
  const { x, y } = await glide(page, 'a.task-action-reply', { steps: 30 })
  await page.waitForTimeout(600)
  await page.mouse.click(x, y)
  await page.waitForTimeout(1500)
  await finishClip(page)
}

// ---- C6: ステータス進行（未処理 → 対応中 → 完了） ----
async function clipC6() {
  const page = await newRecPage('c6_status')
  await login(page)
  await glideClick(page, 'text=賃貸物件の内見日程の調整')
  await page.waitForTimeout(1300)
  await glideClick(page, '.task-detail-status button:has-text("対応中")')
  await page.waitForTimeout(1500)
  await glideClick(page, '.task-detail-status button:has-text("完了")')
  await page.waitForTimeout(1300)
  await glideClick(page, '.task-detail-close')
  await page.waitForTimeout(1600)
  await finishClip(page)
}

// ---- C7: 返信の自動検知（今すぐ取得 → 返信済みへ自動移動） ----
async function clipC7() {
  const page = await newRecPage('c7_reply_detect')
  await login(page)
  await glide(page, 'text=システム保守契約の見積依頼への対応', { steps: 40 })
  await page.waitForTimeout(1000)
  await glideClick(page, 'button:has-text("今すぐ取得")')
  await page.waitForTimeout(2500)
  await glide(page, 'text=システム保守契約の見積依頼への対応', { steps: 50 })
  await page.waitForTimeout(2000)
  await finishClip(page)
}

// ---- C8: 設定画面（時間帯・頻度 → ルール → API 利用状況） ----
async function clipC8() {
  const page = await newRecPage('c8_settings')
  await login(page)
  await glideClick(page, 'a:has-text("設定"), button:has-text("設定")')
  await page.waitForTimeout(1800)
  await page.mouse.move(960, 500)
  // ゆっくりスクロールしながら各セクションを見せる
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 380)
    await page.waitForTimeout(1400)
  }
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 420)
    await page.waitForTimeout(1300)
  }
  await page.waitForTimeout(1500)
  await finishClip(page)
}

const only = process.argv[2]
const all = { c2: clipC2, c4: clipC4, c5: clipC5, c6: clipC6, c7: clipC7, c8: clipC8 }
for (const [name, fn] of Object.entries(all)) {
  if (only && only !== name) continue
  await reset()
  console.log('recording', name)
  await fn()
}
await browser.close()
