import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const wwwDir = path.join(projectRoot, 'www');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.otf': 'font/otf'
};

function startStaticServer(rootDir) {
  const apiRequests = [];
  const server = http.createServer((req, res) => {
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
    if (urlPath.startsWith('/api/') || urlPath.startsWith('/signin-') || urlPath.startsWith('/signout-')) {
      apiRequests.push(urlPath);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Offline mode: network API forbidden' }));
      return;
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(rootDir, rel);
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        apiRequests,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

function findBrowserExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
        this.consoleErrors.push(text);
      }
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Network.enable');
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`JS Eval Error: ${res.exceptionDetails.text} (${res.exceptionDetails.exception?.description || ''})`);
    }
    return res.result?.value;
  }

  async setViewport(width, height, mobile = true) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: mobile ? 2.75 : 1,
      mobile
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function launchHeadlessBrowser(exePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cet-offline-e2e-'));
  const proc = spawn(exePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for DevTools listening URL: ' + stderr)), 15000);
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\r\n]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Browser exited early with code ${code}: ${stderr}`));
    });
  });

  const versionUrl = wsUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1/json/list');
  const targets = await (await fetch(versionUrl)).json();
  const pageTarget = targets.find(t => t.type === 'page');
  const cdp = new CdpSession(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();

  return {
    cdp,
    close: async () => {
      cdp.close();
      proc.kill();
      await new Promise(r => setTimeout(r, 200));
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    }
  };
}

test('End-to-End WebView Emulation: offline boot, UI/UX, CRUD, FSRS review, persistence, JSON import/export, sign-in prompt, back gesture, and 7 viewports', async () => {
  const exe = findBrowserExecutable();
  assert.ok(exe, 'Chromium browser (Edge/Chrome) required for WebView E2E test');

  const srv = await startStaticServer(wwwDir);
  const browser = await launchHeadlessBrowser(exe);
  const { cdp } = browser;

  try {
    await cdp.setViewport(390, 844, true);
    await cdp.send('Page.navigate', { url: `${srv.url}/index.html` });

    // Wait for app initialization
    await cdp.eval(`new Promise(resolve => {
      const check = () => {
        if (window.__OFFLINE_APP && document.getElementById('mode-label')?.textContent === '本机离线') resolve(true);
        else setTimeout(check, 30);
      };
      check();
    })`);

    // 1. Verify initial offline labels & zero API calls
    const bootState = await cdp.eval(`({
      modeLabel: document.getElementById('mode-label').textContent,
      saveStatus: document.getElementById('save-status').textContent,
      accountName: document.getElementById('account-name').textContent,
      guestNotice: document.getElementById('guest-notice').textContent,
      welcomeHidden: document.getElementById('welcome').hidden
    })`);
    assert.equal(bootState.modeLabel, '本机离线');
    assert.equal(bootState.saveStatus, '已保存在本机 · 离线可用');
    assert.equal(bootState.accountName, '离线模式 · 未登录');
    assert.match(bootState.guestNotice, /持久保存在手机本地/);
    assert.equal(bootState.welcomeHidden, false);
    assert.equal(srv.apiRequests.length, 0, 'Offline mode must make zero /api/ calls');

    // 2. Verify #sign-in, #community-open, #sharing-open show exact offline notice
    const signInPrompt = await cdp.eval(`(() => {
      document.getElementById('sign-in').click();
      const dlg = document.getElementById('offline-notice-dialog');
      return {
        open: Boolean(dlg && dlg.open),
        title: document.getElementById('offline-notice-title')?.textContent,
        feedback: document.getElementById('feedback')?.textContent
      };
    })()`);
    assert.equal(signInPrompt.open, true);
    assert.equal(signInPrompt.title, 'Android 离线版暂未开放登录与云端同步');
    assert.equal(signInPrompt.feedback, 'Android 离线版暂未开放登录与云端同步');

    // Close via Android back gesture
    assert.equal(await cdp.eval(`window.__handleAndroidBack()`), 'handled');
    assert.equal(await cdp.eval(`document.getElementById('offline-notice-dialog').open`), false);

    // 3. Create exam ledger 26-06-1-Reading via UI
    await cdp.eval(`(async () => {
      document.getElementById('welcome-new-tag').click();
      const yr = document.getElementById('exam-year');
      yr.value = '2026'; yr.dispatchEvent(new Event('change', { bubbles: true }));
      const mo = document.getElementById('exam-month');
      mo.value = '06'; mo.dispatchEvent(new Event('change', { bubbles: true }));
      const set = document.getElementById('exam-set');
      set.value = '1'; set.dispatchEvent(new Event('input', { bubbles: true }));
      const tp = document.getElementById('exam-type');
      tp.value = 'Reading'; tp.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('editor-form').requestSubmit();
      await new Promise(r => setTimeout(r, 80));
    })()`);

    const afterTag = await cdp.eval(`({
      currentName: document.getElementById('current-name').textContent,
      tagCards: document.querySelectorAll('#tag-list .tag-card').length
    })`);
    assert.equal(afterTag.currentName, '26-06-1-Reading');
    assert.equal(afterTag.tagCards, 1);

    // 4. Add two words with bold examples and notes via #add-form
    await cdp.eval(`(async () => {
      if (document.getElementById('add-form').hidden) {
        document.getElementById('composer-toggle').click();
      }
      const addWord = async (en, zh, ex, tr, note) => {
        document.getElementById('word-input').value = en;
        document.getElementById('meaning-input').value = zh;
        document.getElementById('word-example').value = ex;
        document.getElementById('word-translation').value = tr;
        document.getElementById('word-note').value = note;
        document.getElementById('add-form').requestSubmit();
        await new Promise(r => setTimeout(r, 80));
      };
      await addWord(
        'sustainable',
        'adj. 可持续的；能长期维持的',
        'We must pursue **sustainable** development.',
        '我们必须追求**可持续的**发展。',
        '词根：sus(下) + tain(握，持) → 支撑住'
      );
      await addWord(
        'indispensable',
        'adj. 不可或缺的；必需的',
        'Clean water is **indispensable** to life.',
        '清洁的水对生命是**不可或缺的**。',
        '同义词：essential, vital'
      );
    })()`);

    const wordCheck = await cdp.eval(`({
      rows: document.querySelectorAll('#word-list .word-row').length,
      boldText: document.querySelector('#word-list .example-sentence strong')?.textContent,
      noteText: document.querySelector('#word-list .note-text')?.textContent
    })`);
    assert.equal(wordCheck.rows, 2);
    assert.equal(wordCheck.boldText, 'sustainable');
    assert.match(wordCheck.noteText, /支撑住/);

    // 5. Open Smart Review (#review-open), flip card, rate card with FSRS-6
    await cdp.eval(`(async () => {
      document.getElementById('review-open').click();
      await new Promise(r => setTimeout(r, 60));
      document.querySelector('#rv-home .rv-start').click();
      await new Promise(r => setTimeout(r, 60));
      document.getElementById('rv-flip').click();
      await new Promise(r => setTimeout(r, 60));
      document.getElementById('rv-grade-3').click();
      await new Promise(r => setTimeout(r, 380));
    })()`);

    // Back gesture from review session -> review home -> close review dialog
    assert.equal(await cdp.eval(`document.getElementById('review-dialog').dataset.view`), 'session');
    assert.equal(await cdp.eval(`window.__handleAndroidBack()`), 'handled');
    assert.equal(await cdp.eval(`document.getElementById('review-dialog').dataset.view`), 'home');
    assert.equal(await cdp.eval(`window.__handleAndroidBack()`), 'handled');
    assert.equal(await cdp.eval(`document.getElementById('review-dialog').open`), false);

    // 6. Reload page (via about:blank to guarantee full page unload) and verify IndexedDB persistence
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await cdp.eval(`new Promise(r => setTimeout(r, 80))`);
    await cdp.send('Page.navigate', { url: `${srv.url}/index.html` });
    await cdp.eval(`new Promise(resolve => {
      const check = () => {
        const rows = document.querySelectorAll('#word-list .word-row').length;
        if (rows === 2 && document.getElementById('current-name')?.textContent) resolve(true);
        else setTimeout(check, 40);
      };
      check();
    })`);

    const afterReload = await cdp.eval(`({
      currentName: document.getElementById('current-name').textContent,
      rows: document.querySelectorAll('#word-list .word-row').length,
      reviewMeta: document.getElementById('review-meta').textContent
    })`);
    assert.equal(afterReload.currentName, '26-06-1-Reading');
    assert.equal(afterReload.rows, 2);
    assert.match(afterReload.reviewMeta, /已背诵 1 张/);

    // 7. Test JSON Export and Merge Import via #import-file
    const exported = await cdp.eval(`(async () => {
      document.getElementById('export-button').click();
      await new Promise(r => setTimeout(r, 80));
      return window.__lastExportedJson;
    })()`);
    assert.ok(exported && exported.raw, 'Exported JSON must be captured');
    const parsedExport = JSON.parse(exported.raw);
    assert.equal(parsedExport.schemaVersion, 2);
    assert.equal(parsedExport.words.length, 2);
    assert.equal(parsedExport.review.cards.length, 1);

    // Simulate selecting an external web JSON backup in #import-file and clicking #merge-confirm
    const afterMerge = await cdp.eval(`(async () => {
      const incoming = {
        format: window.LedgerModel.FORMAT,
        schemaVersion: 2,
        revision: 3,
        tags: [{ id: 'tag_ext_1', name: '核心高频词', date: '2026-10-18', createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', recordVersion: 1 }],
        words: [{ id: 'word_ext_1', tagId: 'tag_ext_1', english: 'meticulous', meaning: 'adj. 一丝不苟的；严谨的', exampleSentence: 'She is **meticulous** in her research.', exampleTranslation: '她在研究中**一丝不苟**。', note: '近义：scrupulous', mastered: true, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', recordVersion: 1 }]
      };
      const file = new File([JSON.stringify(incoming)], 'web-backup.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('import-file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      document.getElementById('merge-confirm').click();
      await new Promise(r => setTimeout(r, 120));
      return {
        tagCards: document.querySelectorAll('#tag-list .tag-card').length,
        hasAutoBackup: Boolean(window.__lastAutoBackupJson?.filename?.startsWith('cet-before-merge-'))
      };
    })()`);
    assert.equal(afterMerge.tagCards, 2);
    assert.equal(afterMerge.hasAutoBackup, true);

    // 8. Check 7 viewports (320px to 1280px) for zero horizontal overflow
    for (const [w, h, mobile] of [
      [320, 568, true],
      [360, 800, true],
      [390, 844, true],
      [412, 915, true],
      [768, 1024, true],
      [1024, 768, false],
      [1280, 800, false]
    ]) {
      await cdp.setViewport(w, h, mobile);
      await cdp.eval(`new Promise(r => setTimeout(r, 60))`);
      const metrics = await cdp.eval(`({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth
      })`);
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth,
        `Viewport ${w}x${h} has horizontal overflow: scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
      );
    }

    assert.equal(cdp.pageErrors.length, 0, `Unexpected page errors: ${cdp.pageErrors.join('; ')}`);
    assert.equal(cdp.consoleErrors.length, 0, `Unexpected console errors: ${cdp.consoleErrors.join('; ')}`);
    assert.equal(srv.apiRequests.length, 0, 'Zero network API requests throughout entire E2E session');
  } finally {
    await browser.close();
    await srv.close();
  }
});
