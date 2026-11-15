package expo.modules.novapip

import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NovaPipModule : Module() {
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
      try {
        activity.isInPictureInPictureMode
      } catch (e: Exception) {
        false
      }
    }

    Function("enterPip") {
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(Rational(16, 9))
          .build()
        activity.enterPictureInPictureMode(params)
      } catch (e: Exception) {
        false
      }
    }

    Function("setAutoEnter") { enabled: Boolean ->
      val activity = appContext.activityProvider?.currentActivity ?: return@Function false
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
        val params = PictureInPictureParams.Builder()
          .setAspectRatio(Rational(16, 9))
          .setAutoEnterEnabled(enabled)
          .build()
        activity.setPictureInPictureParams(params)
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
