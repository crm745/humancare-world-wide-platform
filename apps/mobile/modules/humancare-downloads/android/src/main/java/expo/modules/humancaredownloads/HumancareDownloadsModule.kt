package expo.modules.humancaredownloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// Humancare Downloads (Android only): saves a downloaded document into the phone's PUBLIC Downloads folder, shows a "download complete" notification with an OPEN action, and opens a saved file.
//
//  - saveToDownloads: MediaStore.Downloads (Android 10+). The file is written under its own name and extension (the system adds " (1)" when the name is taken), marked finished only after every
//    byte is written, and removed again if writing fails, so a half-written file is never left in Downloads. No storage permission and no folder picker are needed for the app's own files.
//  - notifyDownloadComplete: a native notification (title = file name, "Download complete", an OPEN action). OPEN, and tapping the notification, start the phone's own "view this file" request with
//    read access to that one file, so it works when the app is closed. OPEN is only offered when an installed app can open the file type. It is posted only when notifications are allowed.
//  - openFile: the same "view this file" request, for the in-app Open button. false when no installed app can open it.
// The file's location is a content:// address of the saved file; nothing here reads or sends the document anywhere.
class HumancareDownloadsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("HumancareDownloads")

    // MediaStore.Downloads exists from Android 10 (API 29); older phones keep the file in the app's own storage (done in JavaScript).
    Function("isPublicDownloadsSupported") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q }

    // sourceUri: the file:// address of the downloaded copy in the app's cache. -> { uri, name }
    AsyncFunction("saveToDownloads") { sourceUri: String, displayName: String, mimeType: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw SaveFailedException("Public Downloads need Android 10 or newer.")
      val source = File(Uri.parse(sourceUri).path ?: throw SaveFailedException("The downloaded file is missing."))
      if (!source.exists()) throw SaveFailedException("The downloaded file is missing.")
      val resolver = context.contentResolver
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
      val uri = resolver.insert(collection, values) ?: throw SaveFailedException("Downloads could not be opened for writing.")
      try {
        val out = resolver.openOutputStream(uri, "w") ?: throw SaveFailedException("Downloads could not be opened for writing.")
        out.use { stream -> source.inputStream().use { input -> input.copyTo(stream) } }
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        resolver.update(uri, done, null, null)
      } catch (e: Exception) {
        resolver.delete(uri, null, null) // never leave a half-written file in Downloads
        if (e is CodedException) throw e
        throw SaveFailedException(e.message ?: "The file could not be saved.")
      }
      var savedName = displayName
      resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) savedName = cursor.getString(0) ?: displayName
      }
      mapOf("uri" to uri.toString(), "name" to savedName)
    }

    // Whether the system will show our notifications (the Android 13+ permission and the app's notification switch).
    Function("areNotificationsEnabled") {
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()
    }

    // The channel must exist before the notification permission is asked for on Android 13+.
    Function("ensureChannel") { channelName: String -> ensureChannel(channelName) }

    // -> true when the notification was posted. Only call it after the file is saved.
    AsyncFunction("notifyDownloadComplete") { name: String, uri: String, mimeType: String, title: String, text: String, openLabel: String, channelName: String ->
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (!manager.areNotificationsEnabled()) return@AsyncFunction false
      ensureChannel(channelName)
      val view = viewIntent(Uri.parse(uri), mimeType)
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID) else Notification.Builder(context)
      builder
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle(name)
        .setContentText(text)
        .setSubText(title)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)
      if (canOpen(view)) {
        val pending = PendingIntent.getActivity(context, name.hashCode(), view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        builder.setContentIntent(pending)
        builder.addAction(Notification.Action.Builder(Icon.createWithResource(context, android.R.drawable.ic_menu_view), openLabel, pending).build())
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH)
      manager.notify((System.currentTimeMillis() % Int.MAX_VALUE).toInt(), builder.build())
      true
    }

    // -> false when no installed app can open the file.
    AsyncFunction("openFile") { uri: String, mimeType: String ->
      val view = viewIntent(Uri.parse(uri), mimeType)
      if (!canOpen(view)) return@AsyncFunction false
      try {
        context.startActivity(view)
        true
      } catch (e: ActivityNotFoundException) {
        false
      } catch (e: SecurityException) {
        false
      }
    }
  }

  private fun ensureChannel(channelName: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_HIGH))
    }
  }

  private fun viewIntent(uri: Uri, mimeType: String): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, mimeType)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

  private fun canOpen(intent: Intent): Boolean = intent.resolveActivity(context.packageManager) != null

  companion object {
    const val CHANNEL_ID = "downloads"
  }
}

class SaveFailedException(reason: String) : CodedException("SAVE_FAILED", reason, null)
