import { describe, expect, it } from 'vitest'
import { executorNotices, pairingNotice, shapeNotice } from './executornotice'

/**
 * What the composer tells somebody about the executor they are about to pick.
 *
 * ⛔ **The thing under test is a claim, not a layout.** Decision D2 on this feature was *inherit as
 * today, plus a notice that states the trade* — so the notice is the entire guardrail, and a notice
 * that overstates what is known would be worse than none. These pin the two boundaries: it must say
 * what happens when nobody names an executor, and it must never rank two models against each other.
 */
describe('the Plan & Execute executor notice', () => {
  const base = { plannerModel: '', executorWorkerIds: [], executorModels: {} }

  /**
   * ⛔ **Inherit does not mean cheap**, and this is the sentence that says so. An Executor row left
   * alone hands the choice to the router, which may hand the work back to the account that just
   * planned — and then the whole saving is the review turn. Discovering that in the ledger afterwards
   * is exactly the failure a composer notice exists to prevent.
   */
  it('says plainly that an unnamed executor may be the account that just planned', () => {
    const notice = pairingNotice(base)
    expect(notice.tone).toBe('caution')
    expect(notice.text).toMatch(/scheduler picks/)
    expect(notice.text).toMatch(/the review turn, not the execution/)
  })

  it('distinguishes an account with no model from no account at all', () => {
    const notice = pairingNotice({ ...base, executorWorkerIds: ['w-cx'] })
    expect(notice.tone).toBe('caution')
    expect(notice.text).toMatch(/model is not/)
  })

  it('warns when the executor is the same model that plans', () => {
    const notice = pairingNotice({
      plannerModel: 'gpt-5.6-terra',
      executorWorkerIds: ['w-cx'],
      executorModels: { 'w-cx': 'gpt-5.6-terra' }
    })
    expect(notice.tone).toBe('caution')
    expect(notice.text).toMatch(/the same model that plans/)
    expect(notice.text).toMatch(/saves nothing on the execution/)
  })

  /**
   * ⛔ **Every belief carries its basis, and this one's basis is somebody else's workload.** The
   * numbers are quoted because they size the trade; the sentence has to say they were not measured
   * here, or the composer is asserting something about this fleet that nothing has checked.
   */
  it('quotes the published trade and says it was not measured on this fleet', () => {
    const notice = pairingNotice({
      plannerModel: 'gpt-5.6-terra',
      executorWorkerIds: ['w-agy'],
      executorModels: { 'w-agy': 'gemini-3-flash' }
    })
    expect(notice.tone).toBe('neutral')
    expect(notice.text).toMatch(/not measured on this fleet/)
    expect(notice.text).toMatch(/42%/)
    expect(notice.text).toMatch(/64%/)
  })

  /**
   * ⛔ This module can see two model ids and nothing else — no fitness prior, no price, no history
   * from this fleet. So it may say the models *differ*; it may not say which is better. A confident
   * unsourced ranking is the thing `AGENTS.md` rates worse than saying nothing.
   */
  it('never ranks one model against the other', () => {
    const text = pairingNotice({
      plannerModel: 'gpt-5.6-terra',
      executorWorkerIds: ['w-agy'],
      executorModels: { 'w-agy': 'gemini-3-flash' }
    }).text
    expect(text).not.toMatch(/weaker|stronger|better|worse/i)
  })

  it('reads two accounts on one model as one model', () => {
    const text = pairingNotice({
      plannerModel: '',
      executorWorkerIds: ['w-a', 'w-b'],
      executorModels: { 'w-a': 'gemini-3-flash', 'w-b': 'gemini-3-flash' }
    }).text
    expect(text.match(/Gemini/gi)?.length ?? 0).toBe(1)
  })

  /**
   * ⛔ The approval on the handoff is the *only* look a person gets at the instruction — Plan & Split
   * gets that look and a review turn behind it; this shape gets the first and not the second. Saying
   * so before the task is filed is the point.
   */
  it('always states that nothing comes back to review the work', () => {
    expect(shapeNotice().text).toMatch(/nothing comes back to review/)
    expect(shapeNotice().text).toMatch(/project’s own target/)
    expect(executorNotices(base).map((n) => n.id)).toEqual(['pairing', 'shape'])
  })
})
