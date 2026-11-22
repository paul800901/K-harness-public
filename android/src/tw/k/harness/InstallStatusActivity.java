package tw.k.harness;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Bundle;
import android.widget.Toast;

/**
 * Receives Android's answer to an update install. Not exported, so only the
 * installer's PendingIntent from ShellUpdater can reach it.
 */
public class InstallStatusActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @SuppressWarnings("deprecation") // the typed variant needs Android 13
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            try {
                if (confirm != null) startActivity(confirm);
            } catch (ActivityNotFoundException | SecurityException e) {
                Toast.makeText(this, "更新沒有完成：無法開啟安裝確認", Toast.LENGTH_LONG).show();
            }
        } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
            String detail = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            Toast.makeText(this, "更新沒有完成" + (detail == null ? "" : "：" + detail), Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
