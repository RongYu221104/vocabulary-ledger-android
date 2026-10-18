import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');

const jdkCandidates = [
  process.env.JAVA_HOME,
  'D:\\Agents\\.tools\\jdk-21',
  'C:\\Program Files\\Microsoft\\jdk-21'
].filter(Boolean);

const sdkCandidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  'D:\\Agents\\.tools\\android-sdk'
].filter(Boolean);

const javaHome = jdkCandidates.find(p => fs.existsSync(path.join(p, 'bin', 'java.exe')) || fs.existsSync(path.join(p, 'bin', 'java')));
const androidHome = sdkCandidates.find(p => fs.existsSync(path.join(p, 'platforms')));

if (!javaHome) {
  throw new Error('JAVA_HOME (JDK 21) not found. Checked: ' + jdkCandidates.join(', '));
}
if (!androidHome) {
  throw new Error('ANDROID_HOME (Android SDK) not found. Checked: ' + sdkCandidates.join(', '));
}

// 1. Write android/local.properties
const escapedSdk = androidHome.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${escapedSdk}\n`, 'utf8');

// 2. Sync web assets & Capacitor Android assets
execSync('node scripts/sync-web.mjs', { cwd: projectRoot, stdio: 'inherit' });
execSync('npx cap copy android', { cwd: projectRoot, stdio: 'inherit' });

// 3. Run Gradle unit tests + assembleDebug
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: `${path.join(javaHome, 'bin')};${path.join(androidHome, 'platform-tools')};${process.env.PATH || ''}`
};

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
execSync(`${gradlew} testDebugUnitTest assembleDebug --no-daemon`, {
  cwd: androidDir,
  env,
  stdio: 'inherit'
});

// 4. Copy APK to releases/ and print metadata
const builtApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const releasesDir = path.join(projectRoot, 'releases');
fs.mkdirSync(releasesDir, { recursive: true });
const releaseApk = path.join(releasesDir, 'vocabulary-ledger-offline-debug.apk');
fs.copyFileSync(builtApk, releaseApk);

const bytes = fs.readFileSync(builtApk);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

console.log('\n============================================================');
console.log('Vocabulary Ledger Android Offline APK Built Successfully');
console.log('Gradle APK Path:  ', builtApk);
console.log('Release APK Path: ', releaseApk);
console.log('File Size:        ', bytes.length, `bytes (${(bytes.length / (1024 * 1024)).toFixed(2)} MiB)`);
console.log('SHA-256:          ', sha256);
console.log('============================================================\n');
