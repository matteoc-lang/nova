package expo.modules.novapip

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Rational
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL

class NovaPipModule : Module() {

  companion object {
    private const val CHANNEL = "nova_now_playing"
    private const val NOTIF_ID = 4210
    private const val PREFIX = "expo.modules.novapip."
  }

  private val npMain = Handler(Looper.getMainLooper())
  private var npSession: MediaSession? = null
  private var npReceiver: BroadcastReceiver? = null
  private var npTitle: String = "NOVA"
  private var npSub: String = ""
  private var npArtUrl: String = ""
  private var npArt: Bitmap? = null
  private var npPlaying: Boolean? = null
  private var npPos: Long = 0L
  private var npDur: Long = 0L

  override fun definition() = ModuleDefinition {
    Name("NovaPip")
    Events("onMediaAction")

    OnCreate { npRegister() }
    OnDestroy { npTeardown() }

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
        true
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

    Function("requestNotificationPermission") {
      npAsk()
      true
    }

    Function("showNowPlaying") { title: String, subtitle: String, artworkUrl: String, playing: Boolean ->
      npMain.post { npShow(title, subtitle, artworkUrl, playing) }
      true
    }

    Function("updateNowPlaying") { playing: Boolean, position: Double, duration: Double ->
      npMain.post { npUpdate(playing, position, duration) }
      true
    }

    Function("hideNowPlaying") {
      npMain.post { npHide() }
      true
    }
  }

  private fun npCtx(): Context? {
    return appContext.reactContext ?: appContext.activityProvider?.currentActivity
  }

  private fun npAsk() {
    val activity = appContext.activityProvider?.currentActivity ?: return
    if (Build.VERSION.SDK_INT < 33) return
    try {
      if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4211)
      }
    } catch (e: Exception) {}
  }

  private fun npDispatch(action: String) {
    try {
      val body = Bundle()
      body.putString("action", action)
      sendEvent("onMediaAction", body)
    } catch (e: Exception) {}
  }

  @Suppress("UnspecifiedRegisterReceiverFlag")
  private fun npRegister() {
    if (npReceiver != null) return
    val ctx = npCtx() ?: return
    val r = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, i: Intent?) {
        val a = i?.action ?: return
        npDispatch(a.substringAfterLast('.').lowercase())
      }
    }
    val f = IntentFilter()
    f.addAction(PREFIX + "REWIND")
    f.addAction(PREFIX + "TOGGLE")
    f.addAction(PREFIX + "FORWARD")
    f.addAction(PREFIX + "CLOSE")
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        ctx.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED)
      } else {
        ctx.registerReceiver(r, f)
      }
      npReceiver = r
    } catch (e: Exception) {}
  }

  private fun npTeardown() {
    try {
      val ctx = npCtx()
      val r = npReceiver
      if (ctx != null && r != null) ctx.unregisterReceiver(r)
    } catch (e: Exception) {}
    npReceiver = null
    npHide()
  }

  private fun npChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    try {
      val m = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val ch = NotificationChannel(CHANNEL, "NOVA riproduzione", NotificationManager.IMPORTANCE_LOW)
      ch.setShowBadge(false)
      m.createNotificationChannel(ch)
    } catch (e: Exception) {}
  }

  private fun npEnsureSession(ctx: Context): MediaSession {
    val existing = npSession
    if (existing != null) return existing
    val s = MediaSession(ctx, "NOVA")
    s.setCallback(object : MediaSession.Callback() {
      override fun onPlay() { npDispatch("play") }
      override fun onPause() { npDispatch("pause") }
      override fun onStop() { npDispatch("close") }
      override fun onSeekTo(pos: Long) { npDispatch("seek:" + pos.toString()) }
      override fun onSkipToNext() { npDispatch("forward") }
      override fun onSkipToPrevious() { npDispatch("rewind") }
      override fun onFastForward() { npDispatch("forward") }
      override fun onRewind() { npDispatch("rewind") }
    })
    s.isActive = true
    npSession = s
    return s
  }

  private fun npState(playing: Boolean, posMs: Long): PlaybackState {
    return PlaybackState.Builder()
      .setActions(
        PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO or
        PlaybackState.ACTION_STOP or PlaybackState.ACTION_REWIND or
        PlaybackState.ACTION_FAST_FORWARD or PlaybackState.ACTION_SKIP_TO_NEXT or
        PlaybackState.ACTION_SKIP_TO_PREVIOUS
      )
      .setState(
        if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
        posMs,
        if (playing) 1.0f else 0.0f
      )
      .build()
  }

  private fun npAction(ctx: Context, name: String, req: Int): PendingIntent {
    val i = Intent(ctx, NovaMediaActions::class.java)
    i.action = PREFIX + name
    i.setPackage(ctx.packageName)
    return PendingIntent.getBroadcast(ctx, req, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  @Suppress("DEPRECATION")
  private fun npBuild(ctx: Context, playing: Boolean): Notification {
    npChannel(ctx)
    val s = npEnsureSession(ctx)
    val md = MediaMetadata.Builder()
      .putString(MediaMetadata.METADATA_KEY_TITLE, npTitle)
      .putString(MediaMetadata.METADATA_KEY_ARTIST, npSub)
      .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, npSub)
      .putLong(MediaMetadata.METADATA_KEY_DURATION, npDur)
    val bmp = npArt
    if (bmp != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bmp)
    s.setMetadata(md.build())
    s.setPlaybackState(npState(playing, npPos))

    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, CHANNEL) else Notification.Builder(ctx)
    val icon = ctx.applicationInfo.icon
    b.setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_media_play)
    b.setContentTitle(npTitle)
    b.setContentText(npSub)
    b.setVisibility(Notification.VISIBILITY_PUBLIC)
    b.setOnlyAlertOnce(true)
    b.setOngoing(playing)
    b.setShowWhen(false)
    if (bmp != null) b.setLargeIcon(bmp)

    val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
    if (launch != null) {
      launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      b.setContentIntent(
        PendingIntent.getActivity(ctx, 4200, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      )
    }

    b.setStyle(
      Notification.MediaStyle()
        .setMediaSession(s.sessionToken)
        .setShowActionsInCompactView(0, 1, 2)
    )
    b.addAction(android.R.drawable.ic_media_rew, "-10s", npAction(ctx, "REWIND", 4201))
    b.addAction(
      if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
      "Play/Pausa",
      npAction(ctx, "TOGGLE", 4202)
    )
    b.addAction(android.R.drawable.ic_media_ff, "+10s", npAction(ctx, "FORWARD", 4203))
    b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Chiudi", npAction(ctx, "CLOSE", 4204))
    return b.build()
  }

  private fun npPost(ctx: Context, playing: Boolean) {
    try {
      val m = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      m.notify(NOTIF_ID, npBuild(ctx, playing))
    } catch (e: Exception) {}
  }

  private fun npLoadArt(ctx: Context, url: String, playing: Boolean) {
    if (url.isEmpty() || url == npArtUrl) return
    npArtUrl = url
    Thread {
      try {
        val bmp = BitmapFactory.decodeStream(URL(url).openStream())
        if (bmp != null) {
          npArt = bmp
          npMain.post { npPost(ctx, playing) }
        }
      } catch (e: Exception) {}
    }.start()
  }

  private fun npShow(title: String, subtitle: String, artworkUrl: String, playing: Boolean) {
    val ctx = npCtx() ?: return
    npTitle = title
    npSub = subtitle
    npPlaying = playing
    npPost(ctx, playing)
    npLoadArt(ctx, artworkUrl, playing)
  }

  private fun npUpdate(playing: Boolean, position: Double, duration: Double) {
    val ctx = npCtx() ?: return
    val s = npSession ?: return
    npPos = (position * 1000.0).toLong()
    npDur = (duration * 1000.0).toLong()
    try {
      s.setPlaybackState(npState(playing, npPos))
    } catch (e: Exception) {}
    if (npPlaying == null || npPlaying != playing) {
      npPlaying = playing
      npPost(ctx, playing)
    }
  }

  private fun npHide() {
    try {
      val ctx = npCtx()
      if (ctx != null) {
        val m = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        m.cancel(NOTIF_ID)
      }
    } catch (e: Exception) {}
    try {
      npSession?.isActive = false
      npSession?.release()
    } catch (e: Exception) {}
    npSession = null
    npArt = null
    npArtUrl = ""
    npPlaying = null
    npPos = 0L
    npDur = 0L
  }
}
