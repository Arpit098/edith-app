package com.arpit.edith.system

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import java.io.IOException

/**
 * Pushes in the 15-minute check mode (contracts/push.md): no service and no open connection; every
 * 15 minutes (Android's shortest period, stretched in deep sleep) with a network, one
 * `poll=1&since=<last id>` request shows what came since. Uses less battery than [PushService],
 * at the cost of the delay.
 */
class PushPollJob : JobService() {
  @Volatile private var worker: Thread? = null

  override fun onStartJob(params: JobParameters): Boolean {
    worker = Thread({
      check(applicationContext)
      jobFinished(params, false)
    }, "edith-push-poll").apply { isDaemon = true; start() }
    return true // finished on the worker thread
  }

  override fun onStopJob(params: JobParameters): Boolean = true // cut short (network lost): run again

  /** For Settings → Push: the last check went through, or why not. */
  data class State(val ok: Boolean, val error: String?)

  companion object {
    private const val JOB_ID = 7301
    private const val PERIOD_MS = 15 * 60_000L
    private const val READ_TIMEOUT_MS = 30_000

    @Volatile var state = State(false, null)
      private set

    private fun check(context: Context) {
      val config = PushConfig(context)
      val s = config.load()
      if (!config.enabled || s == null) return
      state = try {
        PushNtfy.read(context, PushNtfy.open(s, config.lastId, poll = true, readTimeoutMs = READ_TIMEOUT_MS), config)
        config.lastCheck = System.currentTimeMillis()
        State(true, null)
      } catch (e: PushNtfy.Refused) {
        State(false, e.message)
      } catch (e: IOException) {
        State(false, "Couldn't reach edith's push server (${e.javaClass.simpleName}); it checks again in 15 minutes.")
      } catch (e: RuntimeException) {
        State(false, "Push check failed: ${e.javaClass.simpleName}.")
      }
    }

    private fun scheduler(context: Context) = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler

    /** Every 15 minutes from now on, across reboots. Leaves a job already scheduled alone (its period keeps running). */
    fun schedule(context: Context): Boolean {
      val jobs = scheduler(context)
      if (jobs.getPendingJob(JOB_ID) != null) return true
      val job = JobInfo.Builder(JOB_ID, ComponentName(context, PushPollJob::class.java))
        .setPeriodic(PERIOD_MS)
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPersisted(true) // RECEIVE_BOOT_COMPLETED
        .build()
      return jobs.schedule(job) == JobScheduler.RESULT_SUCCESS
    }

    fun cancel(context: Context) {
      scheduler(context).cancel(JOB_ID)
      state = State(false, null)
    }
  }
}
