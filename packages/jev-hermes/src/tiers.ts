/**
 * The resident agent's ladder: two rungs, three efforts, and a cut placed
 * where docs/36 §5 says to place it.
 *
 * §5 measured the model router against a labelled corpus and the result was
 * not the one it was built for: on 53 repair tasks, 52 needed only the
 * cheapest tier and none needed the dearest. Fitting a cost ladder to that
 * recovered the constant -- fitted equalled always-cheap -- and at a high
 * failure penalty every arm came out WORSE THAN DOING NOTHING on held-out
 * tasks (1.81 fitted, 3.54 held out, 2.89 always-cheap, 1.04 for a perfect
 * router). docs/25 §2 reproduced exactly.
 *
 * Two things follow, and this file is both of them.
 *
 *   1. THE TIER SWITCH IS ESCALATION, NOT ROUTING. The default is the cheap
 *      rung, and the dear one is reached by the two escape hatches -- which
 *      the model router's policy already sends UP on -- or by a tier score
 *      that is decisively at the top. Hence a single cut at 0.85 on a 0..1
 *      ladder rather than the 0.5 that rounding would give: a router that
 *      routes half the traffic to Opus on a corpus where Sonnet would have
 *      done costs 5x for the same outcome, and §5's mean predicted tier of
 *      0.99 out of 2 is exactly that failure in the making.
 *
 *   2. EFFORT IS THE PRIMARY DIAL. It is free to move and it does not
 *      invalidate the prompt cache, where switching models does: a resident
 *      agent that changes model mid-session pays to rebuild the cache and
 *      then pays the dearer rate. The effort ladder can be adjusted every
 *      turn at no cost at all. docs/36 §5's cost table is about the tier
 *      axis; nothing there argues against the effort axis, and the effort
 *      axis is the one whose wrong answers are cheap.
 *
 * The user-facing shape the caller asked for -- "switch between sonnet and
 * opus and the depth of reasoning by difficulty" -- is therefore honoured
 * with the tier axis biased hard towards cheap and the effort axis free to
 * move. That is a design decision made on a measurement, and if a resident
 * agent's real traffic turns out to have positives where the repair corpus
 * had one, `cuts` is the number to refit.
 */
import { DEFAULT_EFFORT, type RouterConfig, type Tier } from "jev-model-router";

/**
 * Two rungs. Haiku is deliberately absent.
 *
 * Not because it is too weak -- §5 measured Haiku fixing 52 of 53 tasks -- but
 * because this is a general-purpose resident agent rather than a repair bot,
 * and a two-rung ladder has one cut to get wrong instead of two. A caller
 * whose workload looks like §5's corpus should put Haiku back and will save
 * more than this ladder can.
 */
export const HERMES_TIERS: Tier[] = [
  {
    model: "claude-sonnet-5",
    label: "sonnet",
    price: 3,
    says:
      "an ordinary capable model is enough: reading existing code, a change whose shape is clear once the code is read, several files of routine work, running and interpreting a test",
  },
  {
    model: "claude-opus-5",
    label: "opus",
    price: 15,
    says:
      "the strongest model is needed: subtle debugging where the cause is not where the symptom is, an unfamiliar domain, design with consequences that outlast the change, or a task whose own description has to be worked out first",
  },
];

/**
 * The cut, and the one number in this package that is a judgment call rather
 * than a measurement.
 *
 * 0.85 on a two-rung 0..1 ladder means the tier score has to be decisively at
 * the top rung to escalate. It is NOT fitted -- docs/25's rule is that a
 * cutoff belongs to a corpus and no resident-agent corpus exists yet -- and
 * it is set high on purpose, because §5 measured what a middling cut costs.
 *
 * `reason: "fitted"` will appear in decisions made with it, which is the
 * model router's word for "a cut was supplied" and not a claim that anyone
 * fitted this one. Worth knowing when reading a status line.
 */
export const HERMES_CUTS = [0.85];

export const HERMES_ROUTER: RouterConfig = {
  tiers: HERMES_TIERS,
  fallback: "claude-sonnet-5",
  cuts: HERMES_CUTS,
  minConfidence: 0.5,
  /**
   * The escape-hatch cutoff, moved off the model router's 0.7 default on a
   * measurement -- and the one number in this file that IS fitted, loosely.
   *
   * `experiments/hermes` asked eight deliberately varied turns and found
   * `underspecified` clustered at 0.606..0.729 for six of them, with the
   * genuinely vague one at 0.954 and the trivial one at 0.060. The question
   * separates the ends well and piles the middle just under 0.70, so a cutoff
   * there decides most traffic by a margin smaller than one draw of noise:
   * three of eight turns changed their decision between two ways of ASKING
   * the same thing, and two of the three were this hatch flipping.
   *
   * 0.85 puts the vague turn above and all six of the cluster below, with
   * about 0.12 of margin on each side. Eight unlabelled turns is not a
   * corpus, so this is a cutoff moved OUT of a noise band rather than fitted
   * to a label -- which is the weaker claim and the true one.
   */
  escalateAt: 0.85,
  // A resident session's conversation is long by construction, so the
  // downgrade-refusal threshold would fire on nearly every turn if it were
  // left at the router's default. Raised to the point where a downgrade
  // genuinely costs more than it saves. Inherited untested from
  // gargpratyush/jev-router and still untested; flagged, not hidden.
  downgradeMaxContextTokens: 120_000,
  effort: DEFAULT_EFFORT,
  timeoutMs: 10_000,
};
