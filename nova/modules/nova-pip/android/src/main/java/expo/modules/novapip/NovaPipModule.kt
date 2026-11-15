package expo.modules.novapip

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NovaPipModule : Module() {
  companion object {
    const val ACTION_AUDIO_ONLY = "expo.modules.novapip.AUDIO_ONLY"
    @JvmStatic
    var pendingAudioToggle: Boolean = false
  }

  private fun audioAction(activity: Activity): RemoteAction? {
    return try {
      val icon = Icon.createWithResource(activity, R.drawable.ic_nova_headset)
      val intent = Intent(ACTION_AUDIO_ONLY)
        .setClassName(activity.packageName, "expo.modules.novapip.NovaMediaActions")
      val pi = PendingIntent.getBroadcast(
        activity, 1001, intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      RemoteAction(icon, "Solo audio", "Attiva o disattiva la modalità solo audio", pi)
    } catch (e: Exception) {
      null
    }
  }

  private fun buildParams(activity: Activity, autoEnter: Boolean?): PictureInPictureParams {
    val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val a = audioAction(activity)
      if (a != null) b.setActions(listOf(a))
    }
    if (autoEnter != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      b.setAutoEnterEnabled(autoEnter)
    }
    return b.build()
  }

  override fun definition() = ModuleDefinition {
    Name("NovaPip")

    Function("isSupported") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)
      } catch (e: Exception) {
        false
      }
    }

    Function("isInPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try { activity.isInPictureInPictureMode } catch (e: Exception) { false }
    }

    Function("enterPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
        activity.enterPictureInPictureMode(buildParams(activity, null))
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("exitPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try { activity.moveTaskToBack(true); true } catch (e: Exception) { false }
    }

    Function("setAutoEnter") { enabled: Boolean ->
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
        activity.setPictureInPictureParams(buildParams(activity, enabled))
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("takeAudioToggle") {
      val v = pendingAudioToggle
      pendingAudioToggle = false
      v
    }
  }
}
