// アプリごとの「版」を決める（2026-11-24 依頼元の要望）。
//   以前はリポジトリ全体の最新コミットを版にしていたため、eWorks だけ直しても
//   タスク管理アプリにまで「更新」バナーが出ていた。
//   いまは「そのアプリの画面に関わるファイル」を最後に変えたコミットを版とし、
//   そのコミット時刻を画面の ver. 表示（__BUILD_TIME__）にも使う。
//   版が変わらなければ sw.js もバンドルも前回と同じ内容になり、バナーは出ない。
//   ※ GitHub Actions では履歴が要るので checkout に fetch-depth: 0 を付けている（deploy.yml）
import { execSync } from 'node:child_process'

// 画面に関わるパス。共通部品（src/lib・src/pwa・src/styles・src/index.css）は両方に入れる。
// 迷ったら広めに入れる（余分にバナーが出るだけで、出ないよりは安全）
const PATHS = {
  tasks: [
    'src',
    ':(exclude)src/works',
    'index.html',
    'public',
    ':(exclude)public/sw.js',
    'vite.config.js',
    'worker/lib',
    ':(exclude)worker/lib/works',
    'package-lock.json',
    'scripts/generate-sw.mjs',
    'scripts/app-version.mjs',
  ],
  works: [
    'src/works',
    'src/lib',
    'src/pwa',
    'src/styles',
    'src/index.css',
    'works',
    ':(exclude)works/public/sw.js',
    'vite.works.config.js',
    'worker/lib/works',
    'package-lock.json',
    'scripts/generate-sw.mjs',
    'scripts/app-version.mjs',
  ],
}

export function appVersion(app) {
  const paths = PATHS[app]
  if (!paths) throw new Error(`unknown app: ${app}`)
  try {
    const args = paths.map((p) => `'${p}'`).join(' ')
    const out = execSync(`git log -1 --format=%h%x09%cI -- ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const [sha, time] = out.split('\t')
    // 手元で未コミットの変更があるときも、ビルド時刻で区別できるようにする
    const dirty = execSync(`git status --porcelain -- ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    if (sha && time && !dirty) return { version: sha, time }
    if (sha && time) return { version: `${sha}-dev${Date.now()}`, time: new Date().toISOString() }
  } catch {
    /* git が無い環境 */
  }
  return { version: String(Date.now()), time: new Date().toISOString() }
}
