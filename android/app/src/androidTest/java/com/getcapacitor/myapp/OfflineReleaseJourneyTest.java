package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;
import site.chatgpt.rongyu1104.cetledger.MainActivity;

/** Runs against the signed release APK, using only packaged assets and native storage. */
@RunWith(AndroidJUnit4.class)
public class OfflineReleaseJourneyTest {
    private Object eval(ActivityScenario<MainActivity> activity, String js) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        activity.onActivity(a -> {
            WebView view = a.findViewById(com.getcapacitor.android.R.id.webview);
            view.evaluateJavascript(js, result -> { value.set(result); latch.countDown(); });
        });
        assertTrue("WebView callback", latch.await(20, TimeUnit.SECONDS));
        return new JSONTokener(value.get()).nextValue();
    }

    private void waitTrue(ActivityScenario<MainActivity> activity, String js, long timeout) throws Exception {
        long end = System.currentTimeMillis() + timeout;
        while (System.currentTimeMillis() < end) {
            if (Boolean.TRUE.equals(eval(activity, js))) return;
            Thread.sleep(150);
        }
        fail("Timed out: " + js + " result=" + eval(activity, "JSON.stringify(window.__releaseResult || document.body.innerText.slice(0,500))"));
    }

    @Test public void packagedBooksCopyAndSettingsSurviveActivityRestart() throws Exception {
        assertEquals(PackageManager.PERMISSION_DENIED,
            InstrumentationRegistry.getInstrumentation().getTargetContext().checkSelfPermission(Manifest.permission.INTERNET));
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            waitTrue(activity, "!!window.__OFFLINE_APP && !!document.querySelector('#official-open') && document.querySelector('#mode-label').textContent.includes('本机')", 45000);
            assertEquals("Full-copy fixture requires an empty app; never clear a user's existing data", 0,
                ((Number)eval(activity,"(()=>{const b=JSON.parse(AndroidOffline.readStateJson()||'{}');return (b.ledger?.words?.length||0)+(b.ledger?.tags?.length||0)})()")).intValue());
            eval(activity, "(async()=>{try{const wait=async f=>{let end=Date.now()+90000;while(!f()){if(Date.now()>end)throw Error('DOM timeout');await new Promise(r=>setTimeout(r,100));}};"
                + "document.querySelector('#official-open').click();"
                + "for(const id of ['cet4-complete','cet6-complete']){await wait(()=>document.querySelector('.of-row[data-ledger=\"'+id+'\"]'));document.querySelector('.of-row[data-ledger=\"'+id+'\"]').click();await wait(()=>document.querySelector('#of-copy-button:not([disabled])'));if(document.querySelectorAll('.of-entry').length>50)throw Error('unbounded DOM');document.querySelector('#of-copy-button').click();await wait(()=>document.querySelector('.of-copied'));}"
                + "document.querySelector('#of-close').click();document.querySelector('#review-open').click();document.querySelector('.rv-settings-toggle').click();await wait(()=>document.querySelector('#rv-reset-offset'));const select=document.querySelector('#rv-reset-offset');select.value='300';select.dispatchEvent(new Event('change',{bubbles:true}));"
                + "await wait(()=>{try{const b=JSON.parse(AndroidOffline.readStateJson());return b.ledger.words.length===9399&&b.review.settings.utcOffsetMinutes===300;}catch{return false;}});"
                + "const b=JSON.parse(AndroidOffline.readStateJson());if(b.ledger.tags.length!==2||!b.ledger.words.every(w=>w.exampleSentence&&w.exampleTranslation&&w.note.includes('来源：')))throw Error('lossy copy');"
                + "window.__releaseResult={pass:true,words:b.ledger.words.length,tags:b.ledger.tags.length,bytes:AndroidOffline.readStateJson().length};}catch(e){window.__releaseResult={pass:false,error:String(e),stack:e.stack};}})();true");
            waitTrue(activity, "!!window.__releaseResult", 180000);
            JSONObject result = new JSONObject((String)eval(activity, "JSON.stringify(window.__releaseResult)"));
            assertTrue(result.toString(), result.getBoolean("pass"));
            System.out.println("OFFLINE_RELEASE_JOURNEY " + result);
            activity.recreate();
            waitTrue(activity, "!!document.querySelector('#global-stats') && document.querySelector('#global-stats').textContent.includes('9,399')", 45000);
            eval(activity, "document.querySelector('#review-open').click();document.querySelector('.rv-settings-toggle').click();true");
            waitTrue(activity, "document.querySelector('#rv-reset-offset')?.value==='300'", 15000);
            assertEquals(9399, ((Number)eval(activity, "JSON.parse(AndroidOffline.readStateJson()).ledger.words.length")).intValue());
        }
    }

    /** Run separately after adb install -r, with the first journey's fixture still present. */
    @Test public void retainsDataAfterInPlaceReinstall() throws Exception {
        int flags = InstrumentationRegistry.getInstrumentation().getTargetContext().getApplicationInfo().flags;
        assertEquals(0, flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            waitTrue(activity, "!!window.__OFFLINE_APP && document.querySelector('#global-stats')?.textContent.includes('9,399')", 60000);
            assertEquals(9399, ((Number)eval(activity,"JSON.parse(AndroidOffline.readStateJson()).ledger.words.length")).intValue());
            assertEquals(300, ((Number)eval(activity,"JSON.parse(AndroidOffline.readStateJson()).review.settings.utcOffsetMinutes")).intValue());
        }
    }
}
