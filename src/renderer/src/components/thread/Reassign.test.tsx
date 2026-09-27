import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PillOptions } from '../Pill'
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
      currentEffort: false,
      selectedWorkerId: ''
    })
  })

  it('names what the scheduler chose once a run has happened', () => {
    const labels = pillLabels({
      ...base,
      current: { workerId: 'w1', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeFirst'
    })
    expect(labels.workerLabel).toBe('ClaudeFirst')
    expect(labels.selectedWorkerId).toBe('w1')
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
    expect(labels.selectedWorkerId).toBe('w2')
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
    expect(labels.workerLabel).toBe('ClaudeFirst')
    expect(labels.selectedWorkerId).toBe('w1')
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
    expect(labels.selectedWorkerId).toBe('w2')
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
    expect(labels.selectedWorkerId).toBe('')
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
    expect(labels.selectedWorkerId).toBe('')
  })
})

describe('worker dropdown menu selection (t763)', () => {
  const options = [
    { value: '', label: 'Auto (scheduler decides)' },
    { value: 'w1', label: 'ClaudeFirst (claude-code)' },
    { value: 'w2', label: 'ClaudeSecond (claude-code)' },
    { value: 'w3', label: 'ClaudeThird (claude-code)' }
  ]

  it('shows the running worker as selected and Auto unselected when task ran under Auto worker', () => {
    // When a task ran under Auto worker on ClaudeThird (w3), pillLabels yields selectedWorkerId === 'w3'.
    const labels = pillLabels({
      ...base,
      workerId: '',
      changed: false,
      current: { workerId: 'w3', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeThird'
    })
    expect(labels.workerLabel).toBe('ClaudeThird')
    expect(labels.selectedWorkerId).toBe('w3')

    const html = renderToStaticMarkup(
      <PillOptions
        options={options}
        value={labels.selectedWorkerId}
        ariaLabel="Reassign worker"
        onPick={() => {}}
      />
    )

    // ClaudeThird must be marked selected with the checkmark
    expect(html).toContain('data-value="w3"')
    expect(html).toMatch(/data-value="w3"[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-value="w3"[^>]*pill-option--on/)

    // Auto (scheduler decides) must NOT be marked selected or checked
    expect(html).toMatch(/data-value=""[^>]*aria-selected="false"/)
    expect(html).not.toMatch(/data-value=""[^>]*pill-option--on/)
  })

  it('shows Auto as selected and running worker unselected once operator picks Auto worker', () => {
    // Once operator picks Auto, changed is true, and selectedWorkerId reverts to ''
    const labels = pillLabels({
      ...base,
      workerId: '',
      changed: true,
      current: { workerId: 'w3', model: 'claude-opus-5-5', effort: 'high' },
      currentWorkerLabel: 'ClaudeThird'
    })
    expect(labels.workerLabel).toBe('Auto worker')
    expect(labels.selectedWorkerId).toBe('')

    const html = renderToStaticMarkup(
      <PillOptions
        options={options}
        value={labels.selectedWorkerId}
        ariaLabel="Reassign worker"
        onPick={() => {}}
      />
    )

    // Auto (scheduler decides) must be marked selected with the checkmark
    expect(html).toMatch(/data-value=""[^>]*aria-selected="true"/)
    expect(html).toMatch(/data-value=""[^>]*pill-option--on/)

    // ClaudeThird must NOT be marked selected
    expect(html).toMatch(/data-value="w3"[^>]*aria-selected="false"/)
    expect(html).not.toMatch(/data-value="w3"[^>]*pill-option--on/)
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
