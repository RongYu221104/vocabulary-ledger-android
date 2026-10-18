package site.chatgpt.rongyu1104.cetledger;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class MainActivity extends BridgeActivity {

    private static final int PAPER_COLOR = Color.parseColor("#F5F2EB");

    private OfflineStorageBridge storageBridge;
    private boolean bridgeAttached = false;
    private volatile String pendingExportJson = null;
    private volatile String pendingExportFilename = null;
    private ActivityResultLauncher<Intent> exportDocumentLauncher;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        exportDocumentLauncher = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> handleExportResult(result.getResultCode(), result.getData())
        );

        super.onCreate(savedInstanceState);

        configureSystemBarsAndKeyboard();
        attachBridgeIfNeeded();
        configureBackNavigation();
    }

    @Override
    protected void load() {
        attachBridgeIfNeeded();
        super.load();
        attachBridgeIfNeeded();
    }

    private void attachBridgeIfNeeded() {
        if (bridgeAttached) {
            return;
        }
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        if (webView == null && getBridge() != null) {
            webView = getBridge().getWebView();
        }
        if (webView == null) {
            return;
        }
        if (storageBridge == null) {
            storageBridge = new OfflineStorageBridge(this, this::launchExportPicker);
        }
        WebSettings settings = webView.getSettings();
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        webView.setBackgroundColor(PAPER_COLOR);
        webView.addJavascriptInterface(storageBridge, "AndroidOffline");
        bridgeAttached = true;
    }

    private void configureSystemBarsAndKeyboard() {
        Window window = getWindow();
        if (window == null) {
            return;
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        window.setStatusBarColor(PAPER_COLOR);
        window.setNavigationBarColor(PAPER_COLOR);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(true);
            controller.setAppearanceLightNavigationBars(true);
        }
    }

    private void configureBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : findViewById(com.getcapacitor.android.R.id.webview);
                if (webView == null) {
                    finish();
                    return;
                }
                webView.evaluateJavascript(
                    "(typeof window.__handleAndroidBack === 'function') ? window.__handleAndroidBack() : 'exit'",
                    result -> {
                        if (result == null || "\"exit\"".equals(result) || "null".equals(result)) {
                            finish();
                        } else if ("\"toast\"".equals(result)) {
                            Toast.makeText(MainActivity.this, "再按一次返回键退出应用", Toast.LENGTH_SHORT).show();
                        }
                    }
                );
            }
        });
    }

    private void launchExportPicker(String filename, String jsonContent) {
        pendingExportFilename = filename;
        pendingExportJson = jsonContent;
        runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_TITLE, filename);
                exportDocumentLauncher.launch(intent);
            } catch (Exception e) {
                notifyExportResult(false, e.getMessage() != null ? e.getMessage() : "无法打开系统文件选择器");
            }
        });
    }

    private void handleExportResult(int resultCode, Intent data) {
        String content = pendingExportJson;
        String fallbackName = pendingExportFilename != null ? pendingExportFilename : "vocabulary-ledger.json";
        pendingExportJson = null;
        pendingExportFilename = null;

        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null || content == null) {
            notifyExportResult(false, "cancelled");
            return;
        }

        Uri uri = data.getData();
        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
            if (os == null) {
                notifyExportResult(false, "无法打开目标文件流");
                return;
            }
            os.write(content.getBytes(StandardCharsets.UTF_8));
            os.flush();
            String displayName = resolveDisplayName(uri, fallbackName);
            notifyExportResult(true, displayName);
        } catch (Exception e) {
            notifyExportResult(false, e.getMessage() != null ? e.getMessage() : "写入文件失败");
        }
    }

    private String resolveDisplayName(Uri uri, String fallback) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String name = cursor.getString(idx);
                    if (name != null && !name.trim().isEmpty()) {
                        return name.trim();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    private void notifyExportResult(boolean ok, String detail) {
        runOnUiThread(() -> {
            WebView webView = getBridge() != null ? getBridge().getWebView() : findViewById(com.getcapacitor.android.R.id.webview);
            if (webView == null) {
                return;
            }
            String safeDetail = detail == null ? "" : detail
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\r", "")
                .replace("\n", " ");
            String script = "if (typeof window.__onAndroidExportResult === 'function') { window.__onAndroidExportResult("
                + (ok ? "true" : "false") + ", '" + safeDetail + "'); }";
            webView.evaluateJavascript(script, null);
        });
    }
}
