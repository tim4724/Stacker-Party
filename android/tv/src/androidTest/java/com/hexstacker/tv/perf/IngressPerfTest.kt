package com.hexstacker.tv.perf

import android.os.Process
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.hexstacker.core.net.FastlaneReceiver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/**
 * The two segments the other perf tests skip, both of which sit on the controller-input
 * path before and after the part `InputLatencyTest` measures:
 *
 *  1. INGRESS — a DataChannel packet landing on libwebrtc's network thread until the
 *     decoded input reaches the coordinator. On this platform that is two thread
 *     handoffs (`WebRtcFastlane`'s serial executor, then the coordinator's action
 *     channel on Main) plus a kotlinx JSON parse of the fastlane envelope.
 *  2. HANDOFF COST ITSELF — what one thread wake costs on this SoC, at each Android
 *     thread priority. The ingress executor still pays one, and so does the render
 *     thread's condition signal. `EnginePerfTest.dispatchOverhead` prices the coroutine
 *     wrapper; this prices the scheduler underneath it, which is what a priority change
 *     could move — and the answer is that it does not.
 *
 * Web pays neither: its DataChannel `onmessage`, its `processInput` and its rAF repaint
 * are the same thread, so there is no wake to price.
 */
@RunWith(AndroidJUnit4::class)
class IngressPerfTest {

    // ── 1. one thread wake, priced per priority ──────────────────────────────

    /**
     * Signal → the other thread observes it. A `SynchronousQueue` handoff, which is the
     * futex wake every executor/dispatcher/condition on the input path bottoms out in.
     * Measured with the woken thread at each priority the app could give it.
     */
    @Test
    fun wakeLatencyByPriority() {
        header("one thread wake, by priority")
        for ((name, prio) in PRIORITIES) {
            val handoff = SynchronousQueue<Long>()
            val back = SynchronousQueue<Long>()
            val t = Thread {
                Process.setThreadPriority(prio)
                while (true) {
                    val sent = handoff.take()
                    if (sent == 0L) return@Thread
                    back.put(System.nanoTime())
                }
            }
            t.isDaemon = true
            t.start()
            val samples = ArrayList<Long>(ITERS)
            repeat(WARMUP + ITERS) { i ->
                val t0 = System.nanoTime()
                handoff.put(t0)
                val seen = back.take()
                if (i >= WARMUP) samples.add(seen - t0)
                // Let the woken thread park again, so every sample measures a COLD wake —
                // a spinning consumer would report the best case the app never sees.
                Thread.sleep(1)
            }
            handoff.put(0L)
            report("wake @$name", samples)
        }
    }

    // `engineHopByPriority` used to sit here, pricing a dedicated engine thread at each
    // priority against `Dispatchers.Default.limitedParallelism(1)`. Its premise is gone
    // twice over: the coordinator now shares the engine's thread and EngineBridge
    // short-circuits the wrapper when the caller is already on it, so no engine call
    // dispatches at all in production. The finding it existed to record — that thread
    // priority is NOT the lever on this SoC — is kept by `wakeLatencyByPriority` and by
    // the two-pass plan in `ingressPath` below.

    // ── 2. the whole ingress, as WebRtcFastlane runs it ──────────────────────

    /**
     * A packet arriving on a foreign ("network") thread until the decoded input lands on
     * the consumer that stands in for the coordinator — the shipping shape: copy the
     * buffer on the network thread, post to the fastlane's serial executor, parse there,
     * run [FastlaneReceiver], then hand to the consumer.
     *
     * Run at default priority (shipping) and at display priority, since both hops are
     * ours to place.
     */
    @Test
    fun ingressPath() {
        header("DataChannel packet -> coordinator")
        // Each variant twice, alternating: fresh executors per variant means the first
        // one measured also pays the JIT, and a one-pass A/B would credit that to
        // whichever priority happened to run second.
        val plan = listOf(
            "default (shipping)" to DEFAULT_PRIO, "display" to DISPLAY_PRIO,
            "default (shipping), 2nd pass" to DEFAULT_PRIO, "display, 2nd pass" to DISPLAY_PRIO,
        )
        for ((name, prio) in plan) {
            val done = ArrayBlockingQueue<Long>(1)
            val consumer = Executors.newSingleThreadExecutor { r ->
                Thread({ Process.setThreadPriority(prio); r.run() }, "consumer")
            }
            val fastlane = Executors.newSingleThreadExecutor { r ->
                Thread({ Process.setThreadPriority(prio); r.run() }, "fastlane")
            }
            val receiver = FastlaneReceiver()
            val samples = ArrayList<Long>(ITERS)
            repeat(WARMUP + ITERS) { i ->
                // The controller's ring carries the unacked window, so a real packet is
                // rarely a single event; three is a held-finger steady state.
                val payload = packet(seq = i + 1, events = 3).encodeToByteArray()
                val t0 = System.nanoTime()
                // On the network thread: copy out of the reused buffer, then hand over.
                val text = payload.decodeToString()
                fastlane.execute {
                    val obj = Json.parseToJsonElement(text).jsonObject
                    if (FastlaneReceiver.isDataPacket(obj)) {
                        receiver.onDataPacket(obj)
                        // Stands in for the coordinator's action channel: the decoded input
                        // still has to reach the thread the coordinator consumes on.
                        consumer.execute { done.put(System.nanoTime()) }
                    }
                }
                val seen = done.take()
                if (i >= WARMUP) samples.add(seen - t0)
                Thread.sleep(2)
            }
            report("ingress @$name", samples)
            consumer.shutdown()
            fastlane.shutdown()
        }
    }

    /**
     * The same ingress, but with the consumer WARM — because it is now the game thread,
     * which ticks at 60 Hz and is therefore never parked for long. The variant above parks
     * every thread between samples, which was right when the consumer was Main-dispatched
     * behind Compose and wrong now. This says how much of that 0.92 ms was the consumer
     * being cold, i.e. how much is actually left to win here.
     */
    @Test
    fun ingressPathWarmConsumer() {
        header("DataChannel packet -> coordinator, consumer ticking at 60 Hz")
        val done = ArrayBlockingQueue<Long>(1)
        val consumer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "game") }
        val fastlane = Executors.newSingleThreadExecutor { r -> Thread(r, "fastlane") }
        // Stand in for the tick: enough to keep the thread (and its core) out of deep idle,
        // cheap enough not to be the thing being measured.
        val tick = consumer.scheduleAtFixedRate({ Thread.sleep(1) }, 0, 16, TimeUnit.MILLISECONDS)
        val receiver = FastlaneReceiver()
        val samples = ArrayList<Long>(ITERS)
        repeat(WARMUP + ITERS) { i ->
            val text = packet(seq = i + 1, events = 3)
            val t0 = System.nanoTime()
            fastlane.execute {
                val obj = Json.parseToJsonElement(text).jsonObject
                if (FastlaneReceiver.isDataPacket(obj)) {
                    receiver.onDataPacket(obj)
                    consumer.execute { done.put(System.nanoTime()) }
                }
            }
            val seen = done.take()
            if (i >= WARMUP) samples.add(seen - t0)
            Thread.sleep(2) // a held finger's repeat rate, not a burst
        }
        report("ingress, warm consumer", samples)
        tick.cancel(false)
        consumer.shutdownNow()
        fastlane.shutdown()
    }

    /** The parse alone, so the ingress number above splits into work and scheduling. */
    @Test
    fun ingressParseOnly() {
        header("fastlane envelope parse (no threads)")
        for (events in intArrayOf(1, 3, 6)) {
            val receiver = FastlaneReceiver()
            val samples = ArrayList<Long>(ITERS)
            repeat(WARMUP + ITERS) { i ->
                val text = packet(seq = i + 1, events = events)
                val t0 = System.nanoTime()
                val obj = Json.parseToJsonElement(text).jsonObject
                if (FastlaneReceiver.isDataPacket(obj)) receiver.onDataPacket(obj)
                val dt = System.nanoTime() - t0
                if (i >= WARMUP) samples.add(dt)
            }
            report("parse+dedup, $events event(s), ${packet(1, events).length}B", samples)
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /** A fastlane data packet as PartyFastlane._sendDataPacket writes it. */
    private fun packet(seq: Int, events: Int): String {
        val h = (0 until events).joinToString(",") { """{"type":"input","action":"left"}""" }
        return """{"ps":$seq,"t":${1_700_000_000_000L + seq},"h":[$h]}"""
    }

    private fun header(text: String) = Log.i(TAG, "=== $text ===")

    private fun report(label: String, samples: List<Long>) {
        val s = samples.sorted()
        fun p(q: Double) = s[((s.size - 1) * q).roundToLong().toInt()] / 1000.0
        Log.i(
            TAG,
            String.format(
                "%-44s n=%-4d mean=%8.1fus  p50=%8.1f  p95=%8.1f  p99=%8.1f",
                label, s.size, s.average() / 1000.0, p(0.5), p(0.95), p(0.99),
            ),
        )
    }

    private companion object {
        const val TAG = "HexPerf"
        const val WARMUP = 100
        const val ITERS = 400
        const val DEFAULT_PRIO = Process.THREAD_PRIORITY_DEFAULT
        const val DISPLAY_PRIO = Process.THREAD_PRIORITY_DISPLAY

        val PRIORITIES = listOf(
            "default" to Process.THREAD_PRIORITY_DEFAULT,
            "display" to Process.THREAD_PRIORITY_DISPLAY,
            "urgent-display" to Process.THREAD_PRIORITY_URGENT_DISPLAY,
        )

        @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
        val SHIPPING = Dispatchers.Default.limitedParallelism(1)
    }
}
