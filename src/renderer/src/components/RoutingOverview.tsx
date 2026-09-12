import { Fragment, useCallback, useEffect, useState } from 'react'
import {
  evaluateWeightFormula,
  WEIGHT_FORMULAS,
  WEIGHT_SIGNS,
  type RoutingCandidate,
  type RoutingDecision,
  type WeightName
} from '@shared/routing'
import { OBJECTIVE_PRESET_LABELS, PRESETS, presetOf } from '@shared/tasks'
import { rpc, useDaemonEvents } from '../lib/daemon'
import { when } from '../lib/format'
import { termTex, weightFormulaTex } from '../lib/tex'
import { errorMessage } from '@shared/errors.js'
import { Eq, M } from './Math'

/**
 * Analytics > Routing Model > §1 Introduction and the model.
 *
 * ⛔ **Every number on this page is read back from the ledger or evaluated from the published
 * constants, never recomputed from live state.** A score was produced against windows, prompt caches
 * and context sizes that existed for one scheduler tick and are gone by the time anybody opens this
 * tab; re-deriving one now would print a plausible number that answers a different question. The
 * daemon stores the whole breakdown at dispatch — see `routingdecisions.ts` — and §1.6 renders it.
 *
 * ⚠️ Table 1 is built from `WEIGHT_FORMULAS` and `WEIGHT_SIGNS` in `@shared/routing.ts`, the same
 * strings the scheduler stamps on every stored decision, with the balanced column evaluated by the
 * same tiny parser `cost.test.ts` checks the scheduler's `weights()` against. Nothing in it is typed
 * twice. The worked example in §1.4 is arithmetic on those constants, not on live data, and is
 * labelled as such.
 *
 * ⚠️ Every measured figure quoted in the prose names where it was measured — the docs page and the
 * date — because a motivating example that invents its numbers teaches the reader to distrust the
 * real ones underneath.
 */

const PAGE = 5

/**
 * What a value of 1 means for each term, in the paper's words. The daemon keeps its own copy in
 * `scoreLegend` for the controller prompt; this one is for a reader, and says the range as well.
 */
const TERM_NOTES: Record<WeightName, { range: string; meaning: string }> = {
  cacheWarmth: {
    range: '0 … 1',
    meaning: 'the fraction of the provider’s prompt-cache TTL still unspent on the conversation this task would continue'
  },
  contextHeld: {
    range: '0 or 1',
    meaning: 'a conversation carrying this task’s context exists, live or reopenable'
  },
  contextRot: { range: '0 … 1', meaning: 'that conversation’s context window is full (0 below half full)' },
  projectSwitch: { range: '0 or 1', meaning: 'the reusable conversation belongs to another project' },
  quotaRisk: {
    range: '0 … 1',
    meaning: 'the model’s quota pool is at the 92 % high-water mark (0 below 50 %), scaled by how near the reset is; 1 outright on a vendor rate-limit warning'
  },
  cold: { range: '0 or 1', meaning: 'no conversation to reuse — the dispatch pays a full cache write' },
  capabilityFit: { range: '0 … 1', meaning: 'every capability the task declared is present (the share, below 1)' },
  pace: {
    range: '−1 … +1',
    meaning: '+1 measured 4× faster than the fleet’s median task; −1 4× slower; 0 at the median, or unmeasured'
  },
  fitness: {
    range: '0 … 1',
    meaning: 'the model clears the sufficiency bar of the task’s complexity band; 0 a quarter-point under it'
  },
  price: {
    range: '0 … 1',
    meaning: 'estimated cost is 8× the cheapest candidate in the field or more (log scale; 0 for the cheapest)'
  }
}

const TERM_ORDER: WeightName[] = [
  'cacheWarmth',
  'contextHeld',
  'cold',
  'contextRot',
  'projectSwitch',
  'quotaRisk',
  'capabilityFit',
  'pace',
  'fitness',
  'price'
]

export function RoutingOverview(): React.JSX.Element {
  const [page, setPage] = useState(0)
  const [decisions, setDecisions] = useState<RoutingDecision[]>([])
  const [total, setTotal] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await rpc('routing.decisions', { limit: PAGE, offset: page * PAGE })
      setDecisions(result.decisions)
      setTotal(result.total)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [page])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ⚠️ A decision is written at dispatch, so the event that means "there may be a new one" is a task
  // changing state — not a turn, which fires many times inside a run that was already routed.
  useDaemonEvents((event) => {
    if (event.type === 'task.changed' && page === 0) void refresh()
  })

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const balanced = PRESETS.balanced

  return (
    <div className="stack">
      <section className="doc-section">
        <h3>1.1 Motivation</h3>
        <p className="panel-sub">
          Consider an afternoon on a fleet of three subscriptions. It is 16:40. The Claude account
          that did the morning&rsquo;s work is at 78 % of its five-hour window and 61 % of its
          seven-day one; the second Claude account reset an hour ago; the Codex account has plenty of
          headroom but has never touched this repository. Two tasks are waiting: a rename across four
          files, and a schema migration that has to land tonight. The developer now has to answer, for
          each of them, a series of questions that nothing on any vendor&rsquo;s dashboard answers
          directly:
        </p>
        <ul className="doc-list">
          <li>
            <strong>Which account?</strong> The one at 78 % will be refused at 92 %, and a migration
            may need every one of the remaining points; the fresh one is idle but cold; the Codex
            account is cheapest per token and knows nothing.
          </li>
          <li>
            <strong>Which model, at which effort?</strong> The rename does not need the dearest model
            and the migration might; but the price gap between two models on the same subscription is
            not a number the developer was ever shown, and a benchmark that ranks them was measured on
            somebody else&rsquo;s code.
          </li>
          <li>
            <strong>Continue the conversation, or start fresh?</strong> The conversation that did the
            morning&rsquo;s work still remembers the repository and its prompt cache has fourteen
            minutes left. A cache read costs a tenth of a cache write (Anthropic&rsquo;s published
            rates, read 2026-08-24; <em>docs/cost-model.md</em> §1), and on this fleet a continued turn
            read back 41,542 cached tokens and wrote 65 where a cold start would have written all of
            them (measured 2026-08-28; <em>docs/routing.md</em> §4.2a). But that conversation is 71 %
            full, and a full context answers worse.
          </li>
          <li>
            <strong>Compact now, keep it warm, or let it lapse?</strong> Holding a 300k-token
            conversation alive costs about 30k tokens an hour; compacting it costs about 58k once and
            1.2k an hour after; letting it lapse and resuming costs 600k. Compaction overtakes
            keepalive at roughly two hours of expected idleness (<em>docs/cost-model.md</em> §3) — but
            the developer does not know when the next task will arrive, and the quota to pay for the
            compaction has to be there when it does.
          </li>
          <li>
            <strong>Now, or after the reset?</strong> A window that resets in fifty minutes changes
            the answer to every question above, and a reading of that window taken an hour ago may
            already be wrong.
          </li>
        </ul>
        <p className="panel-sub">
          None of these questions is hard in isolation. What makes them hard is that they recur on
          every task, that the answer to each depends on the others, that the inputs change by the
          minute, and that the person answering them is trying to do something else. A developer who
          answers them by hand answers them late, from stale numbers, and with a rule of thumb that
          was right last week. The routing model exists so that they are answered every ten seconds,
          from the current numbers, for no tokens, and so that the developer can go back to the work.
        </p>
      </section>

      <section className="doc-section">
        <h3>1.2 The dilemma: quality, cost and velocity</h3>
        <p className="panel-sub">
          Every one of those questions is an instance of one trade-off. A dispatch can be judged on
          three axes — the <strong>quality</strong> of what comes back, the <strong>cost</strong> of
          getting it (tokens, dollars, and the quota that the next task will need), and the{' '}
          <strong>velocity</strong> with which it lands — and no candidate is best on all three. The
          dearest model on a fresh conversation is the most likely to get a migration right and the
          most expensive way to rename a symbol; the cheapest account is the one that has never seen
          the repository; the fastest way to start is a cold start, which is the most expensive one.
          The candidates the operator can choose between lie on a <em>Pareto frontier</em>: moving
          along it buys one axis with another, and the only way to do better than the frontier is to
          pick a different point on it for a different task.
        </p>
        <p className="panel-sub">
          The right point depends on the task, and it depends on the moment. Three things make the
          choice harder than a fixed preference could handle:
        </p>
        <ol className="doc-list">
          <li>
            <strong>The values move.</strong> A prompt cache is an asset with an expiry: the same
            conversation is the cheapest candidate at ten minutes idle and an ordinary one at
            sixty-one. A quota window fills through the afternoon and resets on a clock. A
            conversation&rsquo;s context only ever grows until somebody compacts it. The best
            candidate for a task at 16:40 is not the best candidate for the same task at 17:30.
          </li>
          <li>
            <strong>The basis numbers are only partly known, and they drift.</strong> What a task
            costs on a subscription is an amortised share of a flat fee, not a bill. How good a model
            is at <em>this</em> codebase is a benchmark prior measured elsewhere, corrected only slowly
            by the fleet&rsquo;s own reviews. How fast an agent is cannot be separated from which tasks
            it happened to get. And vendors reprice models, resize windows and ship new models
            without asking; a rule that was calibrated in August is uncalibrated in September.
          </li>
          <li>
            <strong>The weighting is the operator&rsquo;s, and it differs by project.</strong> A
            side project on a shared subscription wants the cheapest sufficient answer; a launch
            branch two days from a deadline wants the fastest good one; a security fix wants the best
            one at any price. The same fleet serves all three at once, so the trade-off cannot be a
            global constant.
          </li>
        </ol>
        <p className="panel-sub">
          So the problem is not to find <em>the</em> best model or <em>the</em> best account. It is to
          pick the right point on a moving frontier, for each task, under a per-project objective,
          from numbers that carry their own uncertainty — and to do it without the operator having to
          look.
        </p>
      </section>

      <section className="doc-section">
        <h3>1.3 The model</h3>
        <p className="panel-sub">
          The scheduler reduces the choice to one number. On every tick (every ten seconds, and for
          zero tokens), every account that clears the eligibility gates of §4.1 is expanded into its
          routable <M tex="(w, m)" /> account–model pairs, and each pair is asked one question:{' '}
          <strong>how much would I prefer to run this task here, rather than anywhere else?</strong>{' '}
          The answer is a score, and the highest score wins.
        </p>
        <Eq
          n="1"
          tex="S(w, m) \;=\; \sum_{t \in T} \sigma_t \, \lambda_t(\mathbf{o}) \, x_t(w, m)"
        />
        <p className="panel-sub">
          Here <M tex="T" /> is the set of terms in Table 1; <M tex="\sigma_t \in \{+1, -1\}" /> is
          whether the term is a bonus or a penalty; <M tex="x_t(w, m)" /> is the <strong>value</strong>{' '}
          — what was measured about this account, for this task, right now: minutes of prompt cache
          left, percent of a quota window used, how full a conversation&rsquo;s context is; and{' '}
          <M tex="\lambda_t(\mathbf{o})" /> is the <strong>weight</strong> — how much that measurement
          is worth to the operator. The weight is identical for every candidate being compared,
          because it comes from the objective alone. The sum is plain: no normalisation, no cap and no
          logarithm anywhere in it, so a gap of 0.2 is exactly twice a gap of 0.1 and means only that
          one candidate is preferred by that much.
        </p>
        <p className="panel-sub">
          <strong>The objective.</strong> The operator does not set weights. They set three numbers
          that sum to one — in Settings &rsaquo; Global, or per project, or per task:
        </p>
        <Eq n="2" tex="\mathbf{o} = (q, c, v), \qquad q + c + v = 1, \qquad q, c, v \ge 0" />
        <p className="panel-sub">
          The four presets are points in this simplex; <em>balanced</em> is{' '}
          <span className="num">
            quality {balanced.quality.toFixed(2)} · cost {balanced.cost.toFixed(2)} · velocity{' '}
            {balanced.velocity.toFixed(2)}
          </span>
          . Every weight is then an affine function of the three, published in full:
        </p>
        <Eq n="3" tex="\lambda_t(\mathbf{o}) \;=\; a_t + b_t\, q + c_t\, c + d_t\, v" />

        <table className="tbl tbl--paper">
          <caption>
            <strong>Table 1.</strong> The terms of the score, the derivation of each weight from the
            objective, and its value on the balanced preset. The formulas are the ones stamped on
            every stored decision; the balanced column is evaluated from them here.
          </caption>
          <thead>
            <tr>
              <th>Term</th>
              <th>Sign</th>
              <th>Weight <M tex="\lambda_t(\mathbf{o})" /></th>
              <th className="tbl-num">Balanced</th>
              <th>Value <M tex="x_t" /></th>
              <th>What a value of 1 means</th>
            </tr>
          </thead>
          <tbody>
            {TERM_ORDER.map((name) => (
              <tr key={name}>
                <td className="tbl-strong mono tbl-nowrap">{name}</td>
                <td className="tbl-nowrap">{WEIGHT_SIGNS[name] === 1 ? (name === 'pace' ? '± signed' : '+ bonus') : '− penalty'}</td>
                <td className="tbl-nowrap">
                  <M tex={weightFormulaTex(WEIGHT_FORMULAS[name])} />
                </td>
                <td className="tbl-num num tbl-nowrap">
                  {WEIGHT_SIGNS[name] === 1 ? '+' : '−'}
                  {evaluateWeightFormula(WEIGHT_FORMULAS[name], balanced).toFixed(3)}
                </td>
                <td className="num tbl-nowrap">{TERM_NOTES[name].range}</td>
                <td className="dim tbl-wide">{TERM_NOTES[name].meaning}</td>
              </tr>
            ))}
            <tr>
              <td className="tbl-strong mono tbl-nowrap">unproven</td>
              <td className="tbl-nowrap">− penalty</td>
              <td className="tbl-nowrap">
                <M tex="0.35" /> <span className="dim">(fixed)</span>
              </td>
              <td className="tbl-num num tbl-nowrap">−0.350</td>
              <td className="num tbl-nowrap">0 … 1.5</td>
              <td className="dim tbl-wide">the account has never completed a metered turn on this fleet</td>
            </tr>
          </tbody>
        </table>
        <p className="dim">
          The ledger stores each formula as text with the axes spelled out —{' '}
          <code>{WEIGHT_FORMULAS.cacheWarmth}</code> — which is how it is printed under every decision
          in §1.6; the typeset column above abbreviates <em>quality</em>, <em>cost</em> and{' '}
          <em>velocity</em> to <M tex="q, c, v" />.
        </p>
        <p className="panel-sub">
          <strong>Reading the table.</strong> Raise <M tex="c" /> and <code>cacheWarmth</code> and{' '}
          <code>cold</code> both grow: the scheduler starts hugging live prompt caches and serialising
          work onto one conversation. Raise <M tex="v" /> and <code>cold</code> shrinks while{' '}
          <code>pace</code> grows: it stops waiting for the cheap moment and prefers whichever agent
          history says finishes fastest. Raise <M tex="q" /> and <code>contextRot</code> and{' '}
          <code>fitness</code> grow: a full context and an insufficient model cost more. Nothing here
          is a mode or a switch — every term is a continuous function of the three numbers, so a
          project at <M tex="(0.5, 0.4, 0.1)" /> gets exactly the arithmetic that vector implies and
          not the nearest preset&rsquo;s.
        </p>
        <p className="panel-sub">
          <strong>Why this shape answers §1.2.</strong> The moving values are the{' '}
          <M tex="x_t" />, re-measured on every tick from the cache clock, the quota poller and the
          session&rsquo;s own context count, so the score of a candidate changes as its cache decays
          and its window fills. The uncertain basis numbers enter through terms that are{' '}
          <em>shrunk</em> toward a neutral value by how little evidence stands behind them —{' '}
          <code>fitness</code> toward a benchmark prior (§5), <code>pace</code> toward the fleet median
          (§4), the cost estimate toward the fleet&rsquo;s own centre (§3) — and a term that cannot be
          measured at all scores 0 with its absence printed beside it, never a guess. And the
          weighting is the operator&rsquo;s, once, per project: the objective is the only input a
          person supplies, and everything else is measured.
        </p>
        <p className="dim">
          <code>cacheWarmth</code> and <code>contextHeld</code> are not the same term twice.{' '}
          <code>contextHeld</code> is binary — does a conversation carrying this task&rsquo;s context
          exist at all, live or closed-and-reopenable. <code>cacheWarmth</code> is continuous — how
          much of that conversation&rsquo;s prompt-cache TTL is still unspent. A reopenable
          conversation whose prefix has lapsed scores <code>contextHeld 1 · cacheWarmth 0</code>: it
          still remembers the task, it just no longer comes with a discount.
        </p>
      </section>

      <section className="doc-section">
        <h3>1.4 A worked example</h3>
        <p className="panel-sub">
          Two accounts, one task, the balanced objective. <strong>A</strong> already holds this
          task&rsquo;s conversation with 30 minutes of a 60-minute cache left, and is at 70 % of its
          five-hour window with 90 minutes until it resets. <strong>B</strong> is idle, has nothing to
          reuse, and is below 50 % of its window. Terms on which the two score identically —{' '}
          <code>capabilityFit</code>, <code>pace</code>, <code>fitness</code>, <code>price</code> — cancel
          in the comparison and are omitted.
        </p>
        <div className="two-col">
          <table className="tbl tbl--paper">
            <caption>
              <strong>Table 2a.</strong> Account A, warm.
            </caption>
            <thead>
              <tr>
                <th>Term</th>
                <th className="tbl-num">
                  <M tex="x_t" />
                </th>
                <th className="tbl-num">
                  <M tex="\sigma_t \lambda_t" />
                </th>
                <th className="tbl-num">
                  <M tex="\sigma_t \lambda_t x_t" />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="mono">cacheWarmth</td><td className="tbl-num num">0.50</td><td className="tbl-num num">+1.480</td><td className="tbl-num num">+0.740</td></tr>
              <tr><td className="mono">contextHeld</td><td className="tbl-num num">1.00</td><td className="tbl-num num">+1.260</td><td className="tbl-num num">+1.260</td></tr>
              <tr><td className="mono">cold</td><td className="tbl-num num">0.00</td><td className="tbl-num num">−1.190</td><td className="tbl-num num">−0.000</td></tr>
              <tr><td className="mono">quotaRisk</td><td className="tbl-num num">0.48</td><td className="tbl-num num">−0.860</td><td className="tbl-num num">−0.410</td></tr>
              <tr className="tbl-total"><td className="tbl-strong">S(A)</td><td /><td /><td className="tbl-num num tbl-strong">+1.590</td></tr>
            </tbody>
          </table>
          <table className="tbl tbl--paper">
            <caption>
              <strong>Table 2b.</strong> Account B, cold.
            </caption>
            <thead>
              <tr>
                <th>Term</th>
                <th className="tbl-num">
                  <M tex="x_t" />
                </th>
                <th className="tbl-num">
                  <M tex="\sigma_t \lambda_t" />
                </th>
                <th className="tbl-num">
                  <M tex="\sigma_t \lambda_t x_t" />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr><td className="mono">cacheWarmth</td><td className="tbl-num num">0.00</td><td className="tbl-num num">+1.480</td><td className="tbl-num num">+0.000</td></tr>
              <tr><td className="mono">contextHeld</td><td className="tbl-num num">0.00</td><td className="tbl-num num">+1.260</td><td className="tbl-num num">+0.000</td></tr>
              <tr><td className="mono">cold</td><td className="tbl-num num">1.00</td><td className="tbl-num num">−1.190</td><td className="tbl-num num">−1.190</td></tr>
              <tr><td className="mono">quotaRisk</td><td className="tbl-num num">0.00</td><td className="tbl-num num">−0.860</td><td className="tbl-num num">−0.000</td></tr>
              <tr className="tbl-total"><td className="tbl-strong">S(B)</td><td /><td /><td className="tbl-num num tbl-strong">−1.190</td></tr>
            </tbody>
          </table>
        </div>
        <p className="panel-sub">
          A&rsquo;s quota value is <M tex="(70 - 50)/(92 - 50) = 0.476" />, and with 90 of 300
          minutes left against 30 % of the window remaining the reset-horizon factor is exactly 1.
          A wins by 2.78, and the reason is legible: reusing a conversation that already holds the
          task is worth far more than the quota headroom B has spare. Push <M tex="c" /> to 0.7 and
          A&rsquo;s lead widens; push <M tex="v" /> to 0.7 and it narrows, because a cold start stops
          being expensive when starting sooner is the point.
        </p>
        <p className="dim">
          Illustrative arithmetic on the published constants — not a measurement of this fleet. The
          decisions in §1.6 are.
        </p>
      </section>

      <section className="doc-section">
        <h3>1.5 When the arithmetic cannot decide</h3>
        <p className="panel-sub">
          Two scores within <M tex="\varepsilon = 0.1" /> of each other are treated as no difference
          at all. For a task small enough that a controller turn would cost more than the difference
          is worth — under 150k estimated tokens — the top score simply wins. Among tied candidates,
          if some already hold this task&rsquo;s conversation and some do not, the highest-scoring
          holder wins outright and no turn is spent: between two equals, the one that skips a full
          cache write and already remembers the work is strictly cheaper (marked{' '}
          <span className="tag">reuse</span>). For a large task with a genuine tie, the scheduler
          asks the controller agent — handing it every candidate&rsquo;s live terms, first refreshing
          any stale quota reading that might be manufacturing the tie, and discarding any answer that
          names an account which is no longer a candidate by the time it arrives (marked{' '}
          <span className="tag">controller</span>). The arithmetic is never in the critical path: if
          the consult does not answer, the top score dispatches on a timer.
        </p>
      </section>

      <section className="doc-section">
        <h3>1.6 The decisions this fleet has made</h3>
        <p className="panel-sub">
          One row per dispatch, written at the moment the task was handed over — the last {PAGE} of{' '}
          {total} recorded. Open a row to see the full term-by-term derivation for every candidate
          that was in the running: the same arithmetic that ordered them, stored rather than
          recomputed.
        </p>

        {error ? (
          <div className="alert">{error}</div>
        ) : decisions.length === 0 ? (
          <p className="dim">
            {total === 0
              ? 'Nothing has been dispatched since routing decisions started being recorded. The next task the scheduler hands out will appear here.'
              : 'No decisions on this page.'}
          </p>
        ) : (
          <>
            <table className="tbl tbl--paper">
              <caption>
                <strong>Table 3.</strong> The most recent routing decisions, newest first.
              </caption>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Task</th>
                  <th>Chose</th>
                  <th className="tbl-num">Score</th>
                  <th className="tbl-num">Margin</th>
                  <th>Objective</th>
                  <th>Basis</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => {
                  const ranked = [...d.candidates].sort((a, b) => b.score - a.score)
                  const winner = ranked.find((c) => c.chosen) ?? ranked[0]
                  const runnerUp = ranked.find((c) => c !== winner)
                  const margin =
                    winner && runnerUp ? winner.score - runnerUp.score : null
                  const preset = presetOf(d.objective)
                  const open = expanded === d.id
                  return (
                    <Fragment key={d.id}>
                      <tr>
                        <td className="tbl-when">{when(d.decidedAt)}</td>
                        <td className="tbl-title-cell">
                          <div className="tbl-title" title={d.taskTitle}>
                            <span className="tbl-strong">t{d.taskSeq ?? '?'}</span> {d.taskTitle}
                          </div>
                        </td>
                        <td>
                          {d.chosenLabel ?? '—'}
                          {d.warm && <span className="tag tag--ok" style={{ marginLeft: 'var(--sp-1)' }}>warm</span>}
                        </td>
                        <td className="tbl-num num">{winner ? winner.score.toFixed(3) : '—'}</td>
                        <td className="tbl-num num" title={`ε = ${d.epsilon}`}>
                          {margin === null ? (
                            <span className="dim">only one</span>
                          ) : margin <= d.epsilon ? (
                            <span className="warn">{margin.toFixed(3)} ≤ ε</span>
                          ) : (
                            margin.toFixed(3)
                          )}
                        </td>
                        <td className="dim" title={preset ? OBJECTIVE_PRESET_LABELS[preset] : 'custom vector'}>
                          {preset ?? 'custom'}
                        </td>
                        <td>
                          <span className="tag">{d.basis}</span>
                        </td>
                        <td className="tbl-actions">
                          <button className="btn btn--ghost" onClick={() => setExpanded(open ? null : d.id)}>
                            {open ? 'Hide' : 'Show the arithmetic'}
                          </button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="tbl-detail-row">
                          <td colSpan={8}>
                            <DecisionDetail decision={d} ranked={ranked} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>

            <div className="pager">
              <button className="btn btn--ghost" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                ← Newer
              </button>
              <span className="dim">
                Page {page + 1} of {pages} · {total} decision{total === 1 ? '' : 's'} recorded
              </span>
              <button
                className="btn btn--ghost"
                disabled={page + 1 >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Older →
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}

/**
 * One decision, in full: the vector, every weight's derivation, and every candidate's terms.
 *
 * ⚠️ **Zero terms are printed, not dropped.** A derivation showing only what contributed reads as
 * though the rest had been weighed and found small — printing `0.00` beside its basis is what shows
 * that a term is not small but *unmeasurable on this fleet*, which is exactly the finding that made
 * the scheduler publish these bases in the first place.
 */
function DecisionDetail({
  decision,
  ranked
}: {
  decision: RoutingDecision
  ranked: RoutingCandidate[]
}): React.JSX.Element {
  const { objective } = decision
  return (
    <div className="stack" style={{ padding: 'var(--sp-2) 0' }}>
      <div className="notice">
        <strong>Objective in force:</strong>{' '}
        <span className="num">
          quality {objective.quality.toFixed(2)} · cost {objective.cost.toFixed(2)} · velocity{' '}
          {objective.velocity.toFixed(2)}
        </span>
        . Higher score wins; the scale is linear and unitless. A gap of {decision.epsilon} or less
        counts as no difference at all.
      </div>

      <table className="tbl tbl--paper">
        <thead>
          <tr>
            <th>Weight</th>
            <th>
              <M tex="\lambda_t(\mathbf{o})" />
            </th>
            <th className="tbl-num">Value here</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(decision.weights).map(([name, value]) => (
            <tr key={name}>
              <td className="tbl-strong mono">{name}</td>
              <td>
                {decision.weightFormulas[name] ? (
                  <M tex={`${termTex(name)} = ${weightFormulaTex(decision.weightFormulas[name])}`} />
                ) : (
                  <span className="dim">fixed</span>
                )}
              </td>
              <td className="tbl-num num">{value.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {ranked.map((candidate) => (
        <div key={candidate.workerId}>
          <h4 className="doc-h4">
            {candidate.chosen ? '★ ' : ''}
            {candidate.label}
            <span className="dim">
              {' '}
              — {candidate.adapterId}
              {candidate.model ? `/${candidate.model}` : ''} ·{' '}
              {candidate.warm ? 'already holds this task’s context' : 'cold start'}
              {candidate.quotaUnverified ? ' · quota reading not trustworthy' : ''}
            </span>
            <span className="num" style={{ float: 'right' }}>
              {candidate.score.toFixed(3)}
            </span>
          </h4>
          <table className="tbl tbl--paper">
            <thead>
              <tr>
                <th>Term</th>
                <th className="tbl-num">
                  <M tex="x_t" />
                </th>
                <th className="tbl-num">
                  <M tex="\sigma_t \lambda_t" />
                </th>
                <th className="tbl-num">
                  <M tex="\sigma_t \lambda_t x_t" />
                </th>
                <th>why the value is that</th>
              </tr>
            </thead>
            <tbody>
              {candidate.terms.map((term) => (
                <tr key={term.name}>
                  <td className="tbl-strong mono">{term.name}</td>
                  <td className="tbl-num num">{term.value.toFixed(2)}</td>
                  <td className="tbl-num num">
                    {term.sign < 0 ? '−' : '+'}
                    {term.weight.toFixed(3)}
                  </td>
                  <td className="tbl-num num">
                    {term.contribution >= 0 ? '+' : '−'}
                    {Math.abs(term.contribution).toFixed(3)}
                  </td>
                  <td className="dim">{term.basis}</td>
                </tr>
              ))}
              <tr className="tbl-total">
                <td className="tbl-strong">S</td>
                <td /><td /><td className="tbl-num num tbl-strong">
                  {candidate.score >= 0 ? '+' : '−'}
                  {Math.abs(candidate.score).toFixed(3)}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
