import { describe, expect, it } from 'vitest'
import { availableAutoClasses, pillLabels } from './Reassign'

const base = {
  workerId: '',
  model: '',
  effort: '',
  changed: false,
  worker: null,
  inheritedLabel: 'CLI default model',
  current: null,
  currentWorkerLabel: null
}

describe('pillLabels (t674)', () => {
  it('says Auto before anything has run', () => {
    expect(pillLabels(base)).toMatchObject({
      workerLabel: 'Auto worker',
      modelLabel: 'Auto model',
      effortLabel: 'Auto effort',
      currentEffort: false
    })
  })

  it('names what the scheduler chose once a run has happened', () => {
    const labels = pillLabels({
      ...base,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('ClaudeFirst')
    expect(labels.modelLabel).not.toMatch(/auto/i)
    expect(labels.modelLabel).toMatch(/opus/i)
    expect(labels.effortLabel).toBe('High')
    expect(labels.currentEffort).toBe(true)
  })

  it('names the running model after a reassignment that left the model to the scheduler', () => {
    const labels = pillLabels({
      ...base,
      workerId: 'w2',
      model: '__auto__:high',
      worker: { label: 'CodexFirst', defaultEffort: 'medium' },
      current: { workerId: 'w2', model: 'gpt-6-sol', effort: 'xhigh' },
      currentWorkerLabel: 'CodexFirst'
    })
    expect(labels.workerLabel).toBe('CodexFirst')
    expect(labels.modelLabel).not.toMatch(/auto/i)
    expect(labels.effortLabel).not.toMatch(/auto/i)
  })

  it('keeps an explicit pin over what last ran', () => {
    const labels = pillLabels({
      ...base,
      workerId: 'w1',
      model: 'claude-sonnet-5',
      effort: 'low',
      worker: { label: 'ClaudeFirst' },
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.modelLabel).toMatch(/sonnet/i)
    expect(labels.effortLabel).toBe('Low')
  })

  it('does not borrow the previous account’s model for a reassignment that has not run yet', () => {
    const labels = pillLabels({
      ...base,
      workerId: 'w2',
      model: '__auto__',
      worker: { label: 'CodexFirst' },
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('CodexFirst')
    expect(labels.modelLabel).toBe('Auto Model')
    expect(labels.currentEffort).toBe(false)
  })

  it('shows the operator’s pending pick, not the current run, once the selection changes', () => {
    const labels = pillLabels({
      ...base,
      changed: true,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('Auto worker')
    expect(labels.modelLabel).toBe('Auto model')
  })

  it('shows Auto worker when operator explicitly picks Auto worker on a task that ran on a worker', () => {
    const labels = pillLabels({
      ...base,
      workerId: '',
      changed: true,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeThird'
    })
    expect(labels.workerLabel).toBe('Auto worker')
  })
})

describe('availableAutoClasses (t764)', () => {
  it('offers only tiers that an account’s Auto routes can actually dispatch', () => {
    expect(
      availableAutoClasses(
        {
          modelRoutes: [
            { model: 'gemini-3.8-flash', effort: 'high', modelClass: 'med', auto: true },
            { model: 'gemini-3.1-pro', effort: 'high', modelClass: 'high', auto: false }
          ]
        },
        'gemini-3.8-flash'
      )
    ).toEqual(['med'])
  })

  it('uses the inherited model’s class when this account has no Auto table', () => {
    expect(availableAutoClasses({ modelRoutes: [] }, 'gemini-3.8-flash')).toEqual(['med'])
  })
})
