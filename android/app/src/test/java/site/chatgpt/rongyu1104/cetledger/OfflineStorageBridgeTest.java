package site.chatgpt.rongyu1104.cetledger;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OfflineStorageBridgeTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void writeAndReadStatePersistsAtomically() throws Exception {
        File dir = tempFolder.newFolder("offline-store");
        OfflineStorageBridge bridge = new OfflineStorageBridge(dir, null);

        assertEquals("", bridge.readStateJson());

        String sample = "{\"format\":\"cet-android-offline-v1\",\"ledger\":{\"schemaVersion\":2,\"revision\":1}}";
        assertTrue(bridge.writeStateJson(sample));
        assertEquals(sample, bridge.readStateJson());

        // Simulate app restart by creating a new OfflineStorageBridge instance on the same directory
        OfflineStorageBridge restarted = new OfflineStorageBridge(dir, null);
        assertEquals(sample, restarted.readStateJson());
    }

    @Test
    public void corruptedPrimaryRecoversFromBackupOrSqlMirror() throws Exception {
        File dir = tempFolder.newFolder("offline-recovery");
        Map<String, String> sqlStore = new HashMap<>();
        OfflineStorageBridge.SqlMirror mirror = new OfflineStorageBridge.SqlMirror() {
            @Override
            public String read(String key) {
                return sqlStore.get(key);
            }

            @Override
            public boolean write(String key, String json) {
                sqlStore.put(key, json);
                return true;
            }
        };

        OfflineStorageBridge bridge = new OfflineStorageBridge(dir, null, mirror);
        String v1 = "{\"format\":\"cet-android-offline-v1\",\"revision\":1}";
        String v2 = "{\"format\":\"cet-android-offline-v1\",\"revision\":2}";
        assertTrue(bridge.writeStateJson(v1));
        assertTrue(bridge.writeStateJson(v2));

        // Corrupt primary file
        File primary = new File(dir, "ledger_state_v1.json");
        try (FileOutputStream fos = new FileOutputStream(primary, false)) {
            fos.write("corrupted-partial-write".getBytes(StandardCharsets.UTF_8));
        }

        // Should recover v1 from .bak
        assertEquals(v1, bridge.readStateJson());

        // Delete both primary and .bak; should recover v2 from SQLite mirror
        //noinspection ResultOfMethodCallIgnored
        primary.delete();
        //noinspection ResultOfMethodCallIgnored
        new File(dir, "ledger_state_v1.json.bak").delete();
        assertEquals(v2, bridge.readStateJson());
    }

    @Test
    public void invalidJsonIsRejectedWithoutClobberingValidState() throws Exception {
        File dir = tempFolder.newFolder("offline-validation");
        OfflineStorageBridge bridge = new OfflineStorageBridge(dir, null);

        String valid = "{\"format\":\"cet-android-offline-v1\",\"ok\":true}";
        assertTrue(bridge.writeStateJson(valid));
        assertFalse(bridge.writeStateJson(""));
        assertFalse(bridge.writeStateJson(null));
        assertFalse(bridge.writeStateJson("not-json"));
        assertEquals(valid, bridge.readStateJson());
    }

    @Test
    public void exportDelegateAndAutoBackupSanitizeFilenames() throws Exception {
        File dir = tempFolder.newFolder("offline-export");
        AtomicReference<String> exportedName = new AtomicReference<>();
        AtomicReference<String> exportedBody = new AtomicReference<>();

        OfflineStorageBridge bridge = new OfflineStorageBridge(dir, (filename, jsonContent) -> {
            exportedName.set(filename);
            exportedBody.set(jsonContent);
        });

        String payload = "{\"schemaVersion\":2,\"tags\":[],\"words\":[]}";
        assertTrue(bridge.saveAutoBackup("cet-before-restore-2026-10-18.json", payload));
        assertTrue(new File(new File(dir, "backups"), "cet-before-restore-2026-10-18.json").exists());

        bridge.exportJson("../unsafe/name:cet-ledger", payload);
        assertEquals(".._unsafe_name_cet-ledger.json", exportedName.get());
        assertEquals(payload, exportedBody.get());
    }
}
