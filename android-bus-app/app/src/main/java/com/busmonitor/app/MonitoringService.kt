package com.busmonitor.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*

/**
 * Foreground Service that keeps the MonitoringSession alive in the background.
 */
class MonitoringService : Service() {

    companion object {
        private const val CHANNEL_ID = "monitoring_channel"
        private const val NOTIFICATION_ID = 1
        
        const val ACTION_START = "ACTION_START"
        const val ACTION_STOP = "ACTION_STOP"
        
        const val EXTRA_STATION_ID = "EXTRA_STATION_ID"
        const val EXTRA_BUS_NUMBERS = "EXTRA_BUS_NUMBERS"
    }

    private val serviceScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var activeSession: MonitoringSession? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val stationId = intent.getStringExtra(EXTRA_STATION_ID) ?: ""
                val busNumbers = intent.getStringArrayListExtra(EXTRA_BUS_NUMBERS) ?: arrayListOf()
                
                if (stationId.isNotBlank() && busNumbers.isNotEmpty()) {
                    startForegroundService(stationId, busNumbers)
                }
            }
            ACTION_STOP -> {
                stopForegroundService()
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundService(stationId: String, busNumbers: List<String>) {
        val notification = createNotification("Monitoring $stationId for buses: ${busNumbers.joinToString(", ")}")
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        
        acquireWakeLock()
        
        activeSession?.stop()
        activeSession = MonitoringSession(
            context = applicationContext,
            stationId = stationId,
            busNumbers = busNumbers,
            onLog = { msg -> 
                serviceScope.launch { MonitoringEventBus.postLog(msg) }
            },
            onFinished = {
                serviceScope.launch { MonitoringEventBus.setMonitoringState(false) }
                stopForegroundService()
            }
        )
        
        activeSession?.start(serviceScope)
        serviceScope.launch { MonitoringEventBus.setMonitoringState(true) }
    }

    private fun stopForegroundService() {
        activeSession?.stop()
        activeSession = null
        releaseWakeLock()
        stopForeground(true)
        stopSelf()
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BusMonitor::MonitoringWakelock")
            wakeLock?.acquire(MonitoringSession.MAX_CYCLES * MonitoringSession.INTERVAL_MS + 60_000L)
        }
    }

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
        wakeLock = null
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotification(content: String): Notification {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent, 
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Bus Monitor Active")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val name = "Monitoring Service"
            val descriptionText = "Notifications for the background monitoring service"
            val importance = NotificationManager.IMPORTANCE_LOW
            val channel = NotificationChannel(CHANNEL_ID, name, importance).apply {
                description = descriptionText
            }
            val notificationManager: NotificationManager =
                getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }
}
