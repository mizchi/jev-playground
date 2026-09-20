/**
 * The resident agent, as Pi loads it. A re-export; see `../../seams.ts`.
 *
 * This ONE extension covers the same five components as `../../components`,
 * the guard included -- it registers its own `tool_call` handler. So the two
 * profiles are alternatives, and loading both puts two gates on every tool
 * call. `../../test.ts` is what keeps that from being reachable by accident.
 */
export { default } from "jev-hermes/pi";
