// Runs the scheduled background jobs inside the worker process (see worker.js).
//
// Plain setInterval timers, no queue. Every job keeps its own state, so a slow or failing
// job never delays or stops another one. A job that is still running when its next tick
// arrives is skipped, never started a second time. A job that throws is logged and will
// simply run again on its next tick.
//
// A job is { name, intervalMs, runOnStart, run }; `run` is the existing service function.

// A short, identifier-shaped description of a failure for the log: the error's `code` (for example a Prisma "P2002" or a system "ECONNRESET"),
// else its class name, else "Error". A value that does not look like an identifier is never used, so text cannot be smuggled into the line.
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
function safeErrorCode(err) {
  const pick = (value) => (typeof value === 'string' && SAFE_IDENTIFIER.test(value) ? value : null);
  return (err && (pick(err.publicCode) || pick(err.code) || pick(err.name))) || 'Error';
}

function validateJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('createJobRunner needs at least one job');
  const names = new Set();
  for (const job of jobs) {
    if (!job || typeof job.name !== 'string' || !job.name) throw new Error('Every job needs a name');
    if (names.has(job.name)) throw new Error(`Duplicate job name "${job.name}"`);
    names.add(job.name);
    if (!Number.isInteger(job.intervalMs) || job.intervalMs <= 0) {
      throw new Error(`Job "${job.name}" needs a positive whole-number intervalMs`);
    }
    if (typeof job.run !== 'function') throw new Error(`Job "${job.name}" needs a run function`);
  }
}

function createJobRunner(jobs, { logger = console } = {}) {
  validateJobs(jobs);

  const states = jobs.map((job) => ({ job, timer: null, active: false, current: null }));
  let started = false;
  let stopPromise = null;

  function runJob(state) {
    if (stopPromise) return;
    if (state.active) {
      logger.warn(`[jobs] "${state.job.name}" is still running, skipping this run.`);
      return;
    }
    // `active` is the overlap guard. It is set before the job starts and cleared in
    // `finally`, so a job that throws straight away cannot leave itself marked as running.
    state.active = true;
    state.current = (async () => {
      try {
        await state.job.run();
      } catch (err) {
        // The job's name and a short error CODE only, never the exception's message: a database error's message can quote the query and its
        // values (payment, patient or credential data). The job is simply run again on its next tick.
        logger.error(`[jobs] "${state.job.name}" failed: ${safeErrorCode(err)}`);
      } finally {
        state.active = false;
      }
    })();
  }

  // Registers every timer once; calling it again does nothing.
  function start() {
    if (stopPromise) throw new Error('The job runner has been stopped and cannot be started again');
    if (started) return;
    started = true;
    for (const state of states) {
      state.timer = setInterval(() => runJob(state), state.job.intervalMs);
      if (state.job.runOnStart) runJob(state);
    }
  }

  // Stops all future runs, then resolves once every job that was mid-run has finished.
  // Safe to call more than once; later calls get the same promise.
  function stop() {
    if (!stopPromise) {
      for (const state of states) {
        clearInterval(state.timer);
        state.timer = null;
      }
      stopPromise = Promise.allSettled(states.map((state) => state.current)).then(() => undefined);
    }
    return stopPromise;
  }

  return { start, stop };
}

module.exports = { createJobRunner, safeErrorCode };
