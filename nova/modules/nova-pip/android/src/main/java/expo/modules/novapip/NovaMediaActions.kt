package expo.modules.novapip

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class NovaMediaActions : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent?.action == NovaPipModule.ACTION_AUDIO_ONLY) {
      NovaPipModule.pendingAudioToggle = true
    }
  }
}
