package expo.modules.novapip

import android.app.PictureInPictureParams
import android.app.PendingIntent
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NovaPipModule : Module() {
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("NovaPip")
    Events("onPipAction")

    OnCreate {
      val ctx = appContext.reactContext ?: return@OnCreate
      val r = object : BroadcastReceiver() {
        override fun onReceive(c: Context?, i: Intent?) {
          val a = i?.getStringExtra("nova_action") ?: return
          val b = Bundle(); b.putString("action", a)
          try { sendEvent("onPipAction", b) } catch (e: Exception) {}
        }
      }
      val f = IntentFilter("expo.modules.novapip.PIP_ACTION")
      try {
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED)
        else ctx.registerReceiver(r, f)
        receiver = r
      } catch (e: Exception) {}
    }

    OnDestroy {
      try {
        val ctx = appContext.reactContext; val r = receiver
        if (ctx != null && r != null) ctx.unregisterReceiver(r)
      } catch (e: Exception) {}
      receiver = null
    }

    Function("isSupported") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try { Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE) } catch (e: Exception) { false }
    }

    Function("isInPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try { activity.isInPictureInPictureMode } catch (e: Exception) { false }
    }

    Function("enterPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
        pipActions(activity)?.let { b.setActions(it) }
        activity.enterPictureInPictureMode(b.build())
        true
      } catch (e: Exception) { false }
    }

    Function("exitPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try { activity.moveTaskToBack(true); true } catch (e: Exception) { false }
    }

    Function("setAutoEnter") { enabled: Boolean ->
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).setAutoEnterEnabled(enabled)
        pipActions(activity)?.let { b.setActions(it) }
        activity.setPictureInPictureParams(b.build())
        true
      } catch (e: Exception) { false }
    }
  }

  private fun pipActions(activity: android.app.Activity): ArrayList<RemoteAction>? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
    return try {
      val ctx = activity as Context
      fun act(name: String, req: Int): PendingIntent {
        val i = Intent("expo.modules.novapip.PIP_ACTION").setPackage(ctx.packageName)
        i.putExtra("nova_action", name)
        return PendingIntent.getBroadcast(ctx, req, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
      val headset = RemoteAction(Icon.createWithResource(ctx, R.drawable.ic_nova_headset), "Solo audio", "Continua in solo audio", act("audio", 71))
      val play = RemoteAction(Icon.createWithResource(ctx, android.R.drawable.ic_media_play), "Play/Pausa", "Play o pausa", act("toggle", 72))
      val close = RemoteAction(Icon.createWithResource(ctx, android.R.drawable.ic_menu_close_clear_cancel), "Chiudi", "Chiudi il video", act("close", 73))
      arrayListOf(headset, play, close)
    } catch (e: Exception) { null }
  }
}
