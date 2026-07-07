import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto('file://' + process.cwd() + '/slides.html')
await page.waitForTimeout(800)
for (const id of ['c1', 'c3', 'c9']) {
  await page.locator('#' + id).screenshot({ path: `slide_${id}.png` })
}
await browser.close()
