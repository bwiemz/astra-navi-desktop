package app.astranavi.station;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Android Quick Settings Push-to-Talk tile launching MainActivity directly into voice capture.
 */
public final class PushToTalkTileService extends TileService {
    @Override
    public void onStartListening() {
        Tile tile = getQsTile();
        if (tile != null) {
            tile.setLabel(getString(R.string.tile_ptt_label));
            tile.setState(Tile.STATE_INACTIVE);
            tile.updateTile();
        }
    }

    @Override
    public void onClick() {
        Intent launch = new Intent(this, MainActivity.class);
        launch.putExtra(MainActivity.EXTRA_START_VOICE, true);
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= 34) {
            PendingIntent pending = PendingIntent.getActivity(
                    this,
                    47829,
                    launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            startActivityAndCollapse(pending);
        } else {
            startActivityLegacy(launch);
        }
    }

    @SuppressWarnings("deprecation")
    private void startActivityLegacy(Intent intent) {
        startActivityAndCollapse(intent);
    }
}
