// The environment protocol: the variable names the coordinator sets on a worker and the worker's hooks
// (delegate-worker.ts, guard.ts) read, plus ME_PI_UNATTENDED, which a supervisor sets when launching any session.
// Dependency-free so guard.ts can import it without a cycle.

export const ENV_RUN = "ME_PI_RUN";
export const ENV_ROLE = "ME_PI_ROLE";
export const ENV_OUTPUT_DIR = "ME_PI_OUTPUT_DIR";
export const ENV_DENY_DIR = "ME_PI_DENY_DIR";
export const ENV_PARENT = "ME_PI_PARENT";
export const ENV_CHECK = "ME_PI_CHECK";
export const ENV_SKILLS = "ME_PI_SKILLS";
export const ENV_JOB_ID = "ME_PI_DELEGATE_JOB_ID";
export const ENV_ATTEMPT = "ME_PI_DELEGATE_ATTEMPT";
export const ENV_BUDGET = "ME_PI_BUDGET";
export const ENV_UNATTENDED = "ME_PI_UNATTENDED";

/** Whether this process is a delegated worker; the coordinator always sets ME_PI_RUN to "1". */
export const isWorkerProcess = (env: NodeJS.ProcessEnv = process.env) => env[ENV_RUN] === "1";

/** Whether no one watches this session's dialogs (ME_PI_UNATTENDED is "1"), so guard must refuse rather than ask. */
export const isUnattended = (env: NodeJS.ProcessEnv = process.env) => env[ENV_UNATTENDED] === "1";

/** Whether this process is an implement worker. */
export const isImplementWorker = (env: NodeJS.ProcessEnv = process.env) => env[ENV_ROLE] === "implement";

/** A worker's job identity, or undefined unless the job id is non-empty and the attempt a positive safe integer. */
export function workerIdentity(env: NodeJS.ProcessEnv = process.env): { jobId: string; attempt: number } | undefined {
	const jobId = env[ENV_JOB_ID];
	const attempt = Number(env[ENV_ATTEMPT]);
	return jobId && Number.isSafeInteger(attempt) && attempt > 0 ? { jobId, attempt } : undefined;
}
