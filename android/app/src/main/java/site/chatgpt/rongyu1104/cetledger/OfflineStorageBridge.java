package site.chatgpt.rongyu1104.cetledger;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.Arrays;
import java.util.Comparator;

/**
 * Durable local storage bridge for Vocabulary Ledger Android Offline Edition.
 * Uses atomic fsync file writes (primary + .bak + .tmp) inside internal app storage
 * plus an embedded SQLite mirror so data survives app close, force-stop, and device reboot.
 */
public class OfflineStorageBridge {

    public interface ExportDelegate {
        void onRequestExportJson(String filename, String jsonContent);
    }

    private static final String STATE_FILE = "ledger_state_v1.json";
    private static final String STATE_TMP_FILE = "ledger_state_v1.json.tmp";
    private static final String STATE_BAK_FILE = "ledger_state_v1.json.bak";
    private static final String BACKUP_DIR = "backups";
    private static final int MAX_AUTO_BACKUPS = 20;

    private final File storageDir;
    private final ExportDelegate exportDelegate;
    private final SqlMirror sqlMirror;

    public OfflineStorageBridge(Context context, ExportDelegate exportDelegate) {
        this(context.getFilesDir(), exportDelegate, new AndroidSqlMirror(context.getApplicationContext()));
    }

    public OfflineStorageBridge(File storageDir, ExportDelegate exportDelegate) {
        this(storageDir, exportDelegate, null);
    }

    public OfflineStorageBridge(File storageDir, ExportDelegate exportDelegate, SqlMirror sqlMirror) {
        this.storageDir = storageDir;
        this.exportDelegate = exportDelegate;
        this.sqlMirror = sqlMirror;
        if (!this.storageDir.exists()) {
            //noinspection ResultOfMethodCallIgnored
            this.storageDir.mkdirs();
        }
    }

    @JavascriptInterface
    public synchronized String readStateJson() {
        File primary = new File(storageDir, STATE_FILE);
        String content = readValidJsonFile(primary);
        File backup = new File(storageDir, STATE_BAK_FILE);
        boolean needsRepair = content == null;
        if (content == null) content = readValidJsonFile(backup);
        if (sqlMirror != null) {
            String mirrored = sqlMirror.read("primary");
            if (isValidJsonEnvelope(mirrored) && (content == null || savedAt(mirrored).compareTo(savedAt(content)) > 0)) {
                content = mirrored;
                needsRepair = true;
            }
        }
        if (content == null) return "";
        if (needsRepair) writeAtomicFile(primary, new File(storageDir, STATE_TMP_FILE), null, content);
        return content;
    }

    // JS writes UTC ISO savedAt. Legacy undated files keep their old primary/backup priority.
    private static final Pattern SAVED_AT = Pattern.compile("\"savedAt\"\\s*:\\s*\"(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\"");
    private static String savedAt(String json) {
        Matcher match = SAVED_AT.matcher(json);
        return match.find() ? match.group(1) : "";
    }

    @JavascriptInterface
    public synchronized boolean writeStateJson(String json) {
        if (!isValidJsonEnvelope(json)) {
            return false;
        }
        File primary = new File(storageDir, STATE_FILE);
        File tmp = new File(storageDir, STATE_TMP_FILE);
        File bak = new File(storageDir, STATE_BAK_FILE);
        boolean fileOk = writeAtomicFile(primary, tmp, bak, json);
        boolean sqlOk = false;
        if (sqlMirror != null) {
            sqlOk = sqlMirror.write("primary", json);
        }
        return fileOk || sqlOk;
    }

    @JavascriptInterface
    public synchronized boolean saveAutoBackup(String filename, String json) {
        if (!isValidJsonEnvelope(json)) {
            return false;
        }
        File dir = new File(storageDir, BACKUP_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            return false;
        }
        String safeName = sanitizeFilename(filename, "vocabulary-backup.json");
        File target = new File(dir, safeName);
        File tmp = new File(dir, safeName + ".tmp");
        boolean ok = writeAtomicFile(target, tmp, null, json);
        pruneOldBackups(dir);
        return ok;
    }

    @JavascriptInterface
    public void exportJson(String filename, String json) {
        if (exportDelegate == null || !isValidJsonEnvelope(json)) {
            return;
        }
        String safeName = sanitizeFilename(filename, "vocabulary-ledger.json");
        exportDelegate.onRequestExportJson(safeName, json);
    }

    public static String sanitizeFilename(String raw, String fallback) {
        if (raw == null || raw.trim().isEmpty()) {
            return fallback;
        }
        String cleaned = raw.trim().replaceAll("[^a-zA-Z0-9._-]", "_");
        if (!cleaned.toLowerCase().endsWith(".json")) {
            cleaned = cleaned + ".json";
        }
        return cleaned;
    }

    static boolean isValidJsonEnvelope(String raw) {
        if (raw == null) return false;
        String trimmed = raw.trim();
        return trimmed.length() >= 2 && trimmed.startsWith("{") && trimmed.endsWith("}");
    }

    private static String readValidJsonFile(File file) {
        if (file == null || !file.exists() || !file.isFile() || file.length() <= 0) {
            return null;
        }
        try (FileInputStream fis = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = fis.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
            String text = new String(bytes, 0, offset, StandardCharsets.UTF_8);
            return isValidJsonEnvelope(text) ? text : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static boolean writeAtomicFile(File target, File tmp, File bak, String content) {
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        try {
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) {
                //noinspection ResultOfMethodCallIgnored
                parent.mkdirs();
            }
            try (FileOutputStream fos = new FileOutputStream(tmp, false)) {
                fos.write(bytes);
                fos.flush();
                fos.getFD().sync();
            }
            if (bak != null && target.exists() && target.length() > 0) {
                try {
                    try (FileInputStream input = new FileInputStream(target); FileOutputStream output = new FileOutputStream(bak, false)) {
                        byte[] buffer = new byte[32768];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                        output.flush();
                        output.getFD().sync();
                    }
                } catch (IOException ignored) {
                }
            }
            // Same-directory rename uses the local filesystem's atomic replace and works on API 22+.
            // Never delete the old primary to make a failed replacement succeed.
            return tmp.renameTo(target);
        } catch (IOException e) {
            return false;
        }
    }

    private static void pruneOldBackups(File backupDir) {
        File[] files = backupDir.listFiles((d, name) -> name.endsWith(".json"));
        if (files == null || files.length <= MAX_AUTO_BACKUPS) {
            return;
        }
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (int i = 0; i < files.length - MAX_AUTO_BACKUPS; i++) {
            //noinspection ResultOfMethodCallIgnored
            files[i].delete();
        }
    }

    public interface SqlMirror {
        String read(String key);
        boolean write(String key, String json);
    }

    private static final class AndroidSqlMirror extends SQLiteOpenHelper implements SqlMirror {
        private static final String DB_NAME = "cet_offline_store.db";
        private static final int DB_VERSION = 1;
        private static final String TABLE = "kv_store";

        AndroidSqlMirror(Context context) {
            super(context, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE + " (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            onCreate(db);
        }

        @Override
        public synchronized String read(String key) {
            try {
                SQLiteDatabase db = getReadableDatabase();
                try (Cursor cursor = db.query(TABLE, new String[]{"v"}, "k = ?", new String[]{key}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        return cursor.getString(0);
                    }
                }
            } catch (Exception ignored) {
            }
            return null;
        }

        @Override
        public synchronized boolean write(String key, String json) {
            try {
                SQLiteDatabase db = getWritableDatabase();
                ContentValues cv = new ContentValues();
                cv.put("k", key);
                cv.put("v", json);
                cv.put("updated_at", System.currentTimeMillis());
                long rowId = db.insertWithOnConflict(TABLE, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                return rowId != -1;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
