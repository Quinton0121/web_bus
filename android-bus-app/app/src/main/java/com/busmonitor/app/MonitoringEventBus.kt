package com.busmonitor.app

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Singleton event bus to communicate between MonitoringService and MainActivity.
 */
object MonitoringEventBus {

    private val _logs = MutableSharedFlow<String>(replay = 10, extraBufferCapacity = 50)
    val logs = _logs.asSharedFlow()

    private val _isMonitoring = MutableStateFlow(false)
    val isMonitoring = _isMonitoring.asStateFlow()

    suspend fun postLog(message: String) {
        _logs.emit(message)
    }

    fun setMonitoringState(active: Boolean) {
        _isMonitoring.value = active
    }
}
