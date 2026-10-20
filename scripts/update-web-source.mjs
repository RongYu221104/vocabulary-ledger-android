// Capture the website's reviewed public assets for standalone, reproducible Android builds.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),cloud=path.resolve(root,'../cloud');
execFileSync('git',['diff','--quiet','HEAD','--','public'],{cwd:cloud});
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:cloud,encoding:'utf8'}).trim();
const dest=path.join(root,'web-source');
fs.cpSync(path.join(cloud,'public'),dest,{recursive:true});
fs.writeFileSync(path.join(dest,'UPSTREAM.json'),JSON.stringify({repository:'existing Vocabulary Ledger Sites source',gitSha:sha,siteVersion:process.env.LEDGER_SITE_VERSION ? Number(process.env.LEDGER_SITE_VERSION) : null,source:'cloud/public',capturedAt:new Date().toISOString(),notes:'Website-only auth, community and online APIs are disabled by the offline adapter. Original source attribution retained.'},null,2)+'\n');
console.log('Captured reviewed public source',sha);
