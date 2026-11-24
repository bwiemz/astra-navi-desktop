package app.astranavi.station;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/**
 * Homescreen quick-talk widget launching Astra Navi directly into push-to-talk capture.
 */
public final class VoiceWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] widgetIds) {
        if (manager == null || widgetIds == null) return;
        for (int appWidgetId : widgetIds) {
            Intent intent = new Intent(context, MainActivity.class);
            intent.putExtra(MainActivity.EXTRA_START_VOICE, true);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pending = PendingIntent.getActivity(
                    context,
                    appWidgetId,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.voice_widget);
            views.setOnClickPendingIntent(R.id.widget_root, pending);
            views.setOnClickPendingIntent(R.id.widget_action, pending);
            manager.updateAppWidget(appWidgetId, views);
        }
    }
}
