import type { BuildType } from "./training-types";

/* Runs are switched off for now - no Runs tab, run builder, run plan card,
 * run proposals from Geoffrey or run sessions in program lists. The run
 * views and code stay, and stored runs are untouched, so switching this
 * back on (with the backend's const.RUNS_ENABLED) restores them. */
export const RUNS_ENABLED = false;

/** What the "Build ..." buttons offer. */
export const BUILD_KINDS: BuildType[] = RUNS_ENABLED
  ? ["workout", "run", "program"]
  : ["workout", "program"];

/** Program sessions to list - run sessions saved before runs were switched
 * off stay in the program, just out of sight. */
export function showSession(session: { type: string }): boolean {
  return RUNS_ENABLED || session.type !== "run";
}
