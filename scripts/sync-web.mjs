import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const publicDir = process.env.LEDGER_WEB_SOURCE ? path.resolve(process.env.LEDGER_WEB_SOURCE) : path.resolve(projectRoot, 'web-source');
const srcDir = path.resolve(projectRoot, 'src');
const wwwDir = path.resolve(projectRoot, 'www');

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function assertReplace(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`[sync-web] Expected pattern not found for ${label}: ${needle}`);
  }
  return source.replace(needle, replacement);
}

// 1. Materialize the maintained, version-pinned web-source into generated www/.
if (wwwDir !== path.join(projectRoot, 'www') || fs.lstatSync(wwwDir, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('Unsafe generated web directory');
if (fs.existsSync(wwwDir)) fs.rmSync(wwwDir, { recursive: true, force: true });
copyDirRecursive(publicDir, wwwDir);

// 2. Copy Android offline adapter CSS and JS
fs.copyFileSync(path.join(srcDir, 'android-offline.css'), path.join(wwwDir, 'css', 'android-offline.css'));
fs.copyFileSync(path.join(srcDir, 'android-offline.js'), path.join(wwwDir, 'js', 'android-offline.js'));

// 3. Patch www/js/app.js with offline hydration, native export hook, and offline status labels
const appJsPath = path.join(wwwDir, 'js', 'app.js');
let appJs = fs.readFileSync(appJsPath, 'utf8');

appJs = assertReplace(
  appJs,
  "const text = message || (store.mode==='guest' ? '游客账本 · 仅当前页面内存' : '已保存到云端');",
  "const text = message || (store.mode==='guest' ? (window.__OFFLINE_APP ? '已保存在本机 · 离线可用' : '游客账本 · 仅当前页面内存') : '已保存到云端');",
  'app.js status() label'
);

appJs = assertReplace(
  appJs,
  "const cloud=store.mode==='cloud', name=cloud?(identity?.displayName||'ChatGPT 用户'):'游客 · 未登录'; $('mode-label').textContent=cloud?'个人云端':'游客模式';",
  "const cloud=store.mode==='cloud', name=cloud?(identity?.displayName||'ChatGPT 用户'):(window.__OFFLINE_APP?'离线模式 · 未登录':'游客 · 未登录'); $('mode-label').textContent=cloud?'个人云端':(window.__OFFLINE_APP?'本机离线':'游客模式');",
  'app.js renderAccount() label'
);

appJs = assertReplace(
  appJs,
  "if(!identity.authenticated)return;",
  `if(!identity.authenticated){if(typeof window.__onOfflineGuestReady==='function'){await window.__onOfflineGuestReady({getData:()=>data,setData:next=>{data=next;hasData=true;view=defaultView();page=1;},getStore:()=>store,getReviewStore:()=>reviewStore,getReviewUI:()=>reviewUI,feedback,status,render:()=>{reviewStamp++;renderAccount();render();status();updateReviewEntry();reviewUI?.refresh();}});}return;}`,
  'app.js load() offline hydration hook'
);

appJs = assertReplace(
  appJs,
  "status(store.mode==='guest'?'正在更新游客账本…':'保存中…');",
  "status(store.mode==='guest'?(window.__OFFLINE_APP?'正在保存到本机…':'正在更新游客账本…'):'保存中…');",
  'app.js saving() status label'
);

appJs = assertReplace(
  appJs,
  `  function download(raw, filename) {`,
  `  function download(raw, filename) {\n    if (typeof window.__androidExportJson === 'function') { window.__androidExportJson(raw, filename); return; }`,
  'app.js download() native export hook'
);

appJs = assertReplace(
  appJs,
  "feedback(store.mode==='guest'?'已下载游客账本 JSON，请妥善保管。':'已下载最新云端账本 JSON，请妥善保管。');",
  "feedback(store.mode==='guest'?(window.AndroidOffline?'请在系统文件选择器中确认保存位置…':'已导出本机账本 JSON，请妥善保管。'):'已下载最新云端账本 JSON，请妥善保管。');",
  'app.js export button feedback'
);

fs.writeFileSync(appJsPath, appJs, 'utf8');

// Only the shipped Android copy uses durable guest storage; do not promise temporary memory here.
appJs = appJs.replace('已复制「${tag.name}」· 游客账本仅在本页，记得导出 JSON。', '已复制「${tag.name}」并保存在本机。');
fs.writeFileSync(appJsPath, appJs, 'utf8');
const officialUiPath = path.join(wwwDir, 'js', 'official-ui.js');
let officialUi = fs.readFileSync(officialUiPath, 'utf8');
officialUi = assertReplace(officialUi, '游客副本只在当前页面内存中，刷新即清空，记得导出 JSON。', '副本自动保存在本机，关闭应用后仍可离线使用；可导出 JSON 备份。', 'official offline persistence copy');
fs.writeFileSync(officialUiPath, officialUi, 'utf8');

// 4. Patch www/js/review-ui.js with offline review sync label
const reviewUiPath = path.join(wwwDir, 'js', 'review-ui.js');
let reviewUi = fs.readFileSync(reviewUiPath, 'utf8');
reviewUi = assertReplace(
  reviewUi,
  "if (s.mode === 'guest') return '游客：复习进度只在本页，导出 JSON 时一并备份';",
  "if (s.mode === 'guest') return window.__OFFLINE_APP ? '本机离线：复习进度自动保存在手机本地，导出 JSON 时一并备份' : '游客：复习进度只在本页，导出 JSON 时一并备份';",
  'review-ui.js syncText()'
);
fs.writeFileSync(reviewUiPath, reviewUi, 'utf8');

// 5. Patch www/ledger.html and create www/index.html
const ledgerHtmlPath = path.join(wwwDir, 'ledger.html');
let html = fs.readFileSync(ledgerHtmlPath, 'utf8');

html = html
  .replace('href="/favicon.ico"', 'href="favicon.ico"')
  .replace('href="/favicon.svg"', 'href="favicon.svg"')
  .replace('href="/apple-touch-icon.png"', 'href="apple-touch-icon.png"');

html = assertReplace(
  html,
  '<link rel="stylesheet" href="css/styles.css">',
  '<link rel="stylesheet" href="css/styles.css">\n  <link rel="stylesheet" href="css/android-offline.css">',
  'ledger.html stylesheet injection'
);

html = assertReplace(
  html,
  '<script defer src="js/app.js"></script>',
  '<script defer src="js/android-offline.js"></script>\n  <script defer src="js/app.js"></script>',
  'ledger.html script injection'
);

html = assertReplace(
  html,
  '<span id="mode-label">游客模式</span>',
  '<span id="mode-label">本机离线</span>',
  'ledger.html initial mode label'
);

html = assertReplace(
  html,
  '<span id="save-status" role="status">游客账本 · 仅当前页面内存</span>',
  '<span id="save-status" role="status">已保存在本机 · 离线可用</span>',
  'ledger.html initial save status'
);

html = assertReplace(
  html,
  'id="account-name" type="button" class="account-name quiet" aria-haspopup="dialog" aria-controls="community-dialog" disabled>游客 · 未登录</button>',
  'id="account-name" type="button" class="account-name quiet" aria-haspopup="dialog" aria-controls="community-dialog" disabled>离线模式 · 未登录</button>',
  'ledger.html initial account name'
);

html = assertReplace(
  html,
  '<p id="guest-notice" class="mode-notice">游客账本不保存：刷新或关闭页面即清空，请及时导出 JSON 备份。</p>',
  '<p id="guest-notice" class="mode-notice">所有账本、词条与复习进度均自动持久保存在手机本地，也可随时导出 JSON 备份。</p>',
  'ledger.html guest notice'
);

html = assertReplace(
  html,
  'id="import-file" type="file" accept=".json,application/json" hidden>',
  'id="import-file" type="file" accept=".json,application/json,text/json,text/plain,application/octet-stream" hidden>',
  'ledger.html import-file MIME types'
);

html = assertReplace(
  html,
  '游客的复习进度只保存在本页，导出 JSON 时会一并备份；登录后自动同步到个人云端。',
  'Android 离线版的复习进度会自动持久保存在手机本地，导出 JSON 时会一并备份。',
  'ledger.html review guide text'
);

html = assertReplace(
  html,
  '隐私与数据：游客词条仅在当前页面内存中；ChatGPT 登录后存入个人云端账本。',
  '隐私与数据：Android 离线版所有账本、词条与复习进度均持久保存在手机本机存储中，无需联网即可完整使用。',
  'ledger.html footer text'
);

html = assertReplace(html,
  '未公开账本仅你可见；社区只开放你勾选的账本，独立分享链接开放已选快照。请定期导出 JSON 备份。',
  '本机数据不会自动上传；请定期导出 JSON，并在应用或卓易通容器之外另存备份。',
  'ledger.html offline privacy footer');
html = assertReplace(html,
  'Sites 可设置访问统计与安全 Cookie，不含词条内容。',
  '卸载应用、清除应用或卓易通容器数据可能导致本机内容丢失。',
  'ledger.html offline recovery footer');

fs.writeFileSync(ledgerHtmlPath, html, 'utf8');
fs.writeFileSync(path.join(wwwDir, 'index.html'), html, 'utf8');

console.log('[sync-web] Successfully synced maintained web-source -> www');
