package com.hexstacker.tv

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.net.ServerSocket

/**
 * CouchPad room advertisement (contract §8): publishes the open room over DNS-SD so the
 * CouchPad launcher on a phone in the same house can offer a one-tap join with no QR scan
 * and no typed room code. Mirrors appletv RoomAdvertiser.swift.
 *
 * The room code is the entire payload. The launcher resolves it against the relay (the
 * same probe a typed code takes), and that answer, not the LAN, supplies the join URL, the
 * platform tag and whether the room is still open. So an advertisement can name a room but
 * cannot propose an origin, and this app declares itself in exactly one place: the
 * controller-URL template it registers at create (RelayConfig.controllerUrlTemplate). There
 * is no version key either: `_couchpad._tcp` plus a code some relay knows is the whole gate.
 *
 * The service instance name is the TV's own name ("Living Room"), which the launcher shows
 * verbatim so a player with two TVs can tell the rooms apart. It never leaves the LAN: the
 * relay is told the platform and nothing else. NsdManager needs a port to register, and the
 * launcher never dials it, so a throwaway [ServerSocket] supplies one that nothing serves.
 *
 * Everything here is an accelerator, never the only route in. mDNS is blocked on
 * AP-isolated and guest networks, so failures are logged and swallowed and the on-screen QR
 * and room code stay the universal path.
 *
 * No permission is declared: Local Network Protections are enforced only for apps targeting
 * API 37, and this app targets 36. Re-check when targetSdk moves: if registration needs
 * ACCESS_LOCAL_NETWORK there, discovery of this display stops with nothing but the log line
 * below to say so.
 *
 * Threading: unlike the tvOS twin, whose caller is @MainActor throughout, this one is driven
 * from TWO threads — the game thread (roster/room changes via TvDisplayOutput.syncAdvertisement,
 * and the relay's onReplaced) and Main (the Activity's onStop/onDestroy). So both entry points
 * are synchronized: a withdraw() racing an advertise() could otherwise interleave so the
 * registration lands AFTER the unregister, leaving a record (and its socket) alive for a room
 * the display has already backgrounded away from — and `advertisedRoom` would then make the
 * next advertise() a no-op, so nothing would ever take it down.
 */
class RoomAdvertiser(private val context: Context) {

    private val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
    private var listener: NsdManager.RegistrationListener? = null
    private var socket: ServerSocket? = null
    private var advertisedRoom: String? = null

    /**
     * Publish [room], replacing any live record. Idempotent: every relay rejoin re-confirms
     * the same room, and re-registering on each one would churn the network for nothing.
     */
    @Synchronized
    fun advertise(room: String) {
        if (room == advertisedRoom && listener != null) return
        withdraw()
        val nsd = nsd ?: return
        if (room.isEmpty()) return
        val registration = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                // NsdManager renames on a name clash, so this is the label actually on the wire.
                Log.i(TAG, "advertising as ${info.serviceName}")
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "advertise failed: $errorCode")
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        runCatching {
            val socket = ServerSocket(0)
            val info = NsdServiceInfo().apply {
                serviceName = deviceLabel()
                serviceType = SERVICE_TYPE
                port = socket.localPort
                setAttribute(CODE_KEY, room)
            }
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)
            this.socket = socket
            this.listener = registration
            this.advertisedRoom = room
        }.onFailure {
            Log.w(TAG, "advertise refused to start: ${it.message}")
            withdraw()
        }
    }

    /**
     * Withdraw the record (an mDNS goodbye). A record that outlives its room only costs a
     * player a wasted tap (the code then resolves to nothing and no card appears), but there
     * is no reason to leave one up.
     */
    @Synchronized
    fun withdraw() {
        listener?.let { runCatching { nsd?.unregisterService(it) } }
        listener = null
        runCatching { socket?.close() }
        socket = null
        advertisedRoom = null
    }

    /** The TV's own name, as the owner set it; the model is the fallback on a box that has none. */
    private fun deviceLabel(): String {
        val name = runCatching {
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull()
        return name?.trim()?.takeIf { it.isNotEmpty() } ?: Build.MODEL
    }

    private companion object {
        const val TAG = "RoomAdvertiser"

        /** NsdManager's convention includes the trailing dot, iOS omits it; same wire protocol. */
        const val SERVICE_TYPE = "_couchpad._tcp."

        /** TXT key for the room code (§8). */
        const val CODE_KEY = "c"
    }
}
