/**
 * Preset-scoped half of the dispatcher bundle: the model-facing tools for the
 * `dispatcher` agent preset.
 *
 * Definitions are raw JSON Schema and workers are started/controlled through
 * the injected Host subagent service, so this module needs no package imports.
 *
 * The control tools deliberately use unique names (`dispatch_update`,
 * `dispatch_stop`, `dispatch_workers`). Plain `send_message` /
 * `interrupt_agent` are registered per-Agent by the Agent Teams bundle in some
 * profiles and address teammates by name; a dispatch worker's durable session
 * id is not a teammate name, so those tools report "active teammate not found"
 * for dispatched workers. These tools address workers directly.
 */
export const name = 'dispatcher-tools'
export const inject = ['tools', 'subagents', 'dispatcherBoard']

/** Workers run a lean worker preset: execution/verification tools only, no delegation. */
const WORKER_PRESET = 'dispatcher-worker'
/** Allow a dispatcher that is itself a child session to still start a worker. */
const WORKER_MAX_DEPTH = 2
/** Verification level used when the caller omits it. */
const DEFAULT_VERIFICATION = 'quick'

const dispatchParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description: 'Short task name shown on the dispatch board. Keep it under 80 characters.',
    },
    brief: {
      type: 'string',
      description:
        'Complete, self-contained work order for the worker. The worker cannot see this conversation, so include the goal, exact files/modules in scope, acceptance criteria, verification commands, project constraints, and the report format. The dispatcher appends the verification/budget section and any resume handoff automatically.',
    },
    write_scopes: {
      type: 'array',
      description:
        'Workspace-relative files or directories this task will modify. Enforced as a write lease: a dispatch whose scopes overlap a pending/running dispatch in the same workspace is rejected unless `allow_overlap` is true. Use `[]` (default) for read-only tasks.',
      items: { type: 'string' },
    },
    allow_overlap: {
      type: 'boolean',
      description:
        'Set true only when overlapping write scopes are intentional (for example a reviewed fix-up of the same file). Otherwise leave unset.',
    },
    verification: {
      type: 'string',
      enum: ['quick', 'full'],
      description:
        'Verification budget level. `quick` (default): typecheck/build plus the smallest check directly related to the change; do not run full browser tours, screenshots or multi-viewport checks. `full`: run the project\'s complete acceptance procedure (browser tour, screenshots, multi-viewport).',
    },
    budget_minutes: {
      type: 'integer',
      description:
        'Optional time budget for the worker, a positive integer number of minutes (1-480). The worker is told to stop expanding work when the budget is exceeded and to report completed code plus a handoff checklist instead. This is guidance; the dispatcher does not hard-kill the worker.',
    },
    resume_of: {
      type: 'string',
      description:
        'Optional earlier dispatch id (for example "d28"). The previous result summary and handoff are prepended to this brief so a new worker can continue instead of rediscovering context.',
    },
    cwd: {
      type: 'string',
      description: 'Optional working directory for the worker. Omit to inherit this session directory.',
    },
  },
  required: ['title', 'brief'],
}

const dispatchOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dispatchId: { type: 'string' },
      childId: { type: 'string' },
      status: { type: 'string' },
    },
    required: ['dispatchId', 'childId', 'status'],
  },
  render: (_args, value) => [
    {
      type: 'text',
      text: `dispatched ${value.dispatchId} to worker ${value.childId} (running in the background; its completion notice will start a new turn)`,
    },
  ],
}

const boardParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      description: 'Optional status filter: pending, running, done, failed, stopped or unknown.',
    },
  },
}

const updateParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dispatch_id: {
      type: 'string',
      description: 'Dispatch id from the dispatch receipt or dispatcher_board (for example "d19").',
    },
    message: {
      type: 'string',
      description:
        'Steering message for the worker. It is delivered at the worker\'s next step boundary; include every changed premise (files modified by other work, test assertions removed, new acceptance criteria) because the worker cannot see other workers.',
    },
  },
  required: ['dispatch_id', 'message'],
}

const stopParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dispatch_id: {
      type: 'string',
      description: 'Dispatch id of the worker whose current turn should stop.',
    },
  },
  required: ['dispatch_id'],
}

const workersParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {},
}

const STATUS_LABEL = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'unknown',
}

/** Format one duration for the board/worker listings. */
function elapsed(from, to = Date.now()) {
  const millis = typeof from === 'number' ? to - from : 0
  if (!Number.isFinite(millis) || millis < 0) return '?'
  if (millis < 60000) return `${Math.max(1, Math.round(millis / 1000))}s`
  if (millis < 3600000) return `${Math.round(millis / 60000)}m`
  return `${(millis / 3600000).toFixed(1)}h`
}

/** Format the live progress line of one running worker. */
function progressText(entry) {
  const progress = entry.progress && typeof entry.progress === 'object' ? entry.progress : null
  if (progress === null) return ''
  const parts = []
  if (typeof progress.step === 'number') parts.push(`step=${progress.step}`)
  if (typeof progress.lastTool === 'string' && progress.lastTool.length > 0) {
    const since = typeof progress.lastToolAt === 'number' ? ` ${elapsed(progress.lastToolAt)} ago` : ''
    parts.push(`last=${progress.lastTool}${since}`)
  }
  if (typeof progress.toolCalls === 'number' && progress.toolCalls > 0) parts.push(`calls=${progress.toolCalls}`)
  return parts.join(' ')
}

/** @param {Record<string, unknown>} entry */
function formatEntry(entry) {
  const parts = [`[${entry.id}] ${STATUS_LABEL[entry.status] ?? entry.status} ${entry.title}`]
  if (entry.childId) parts.push(`worker=${entry.childId}`)
  if (entry.verification) parts.push(`verify=${entry.verification}${entry.budgetMinutes ? ` budget=${entry.budgetMinutes}m` : ''}`)
  if (Array.isArray(entry.writeScopes) && entry.writeScopes.length > 0) parts.push(`scope=${entry.writeScopes.join(',')}`)
  if (entry.status === 'running' || entry.status === 'pending') {
    const budget = typeof entry.budgetMinutes === 'number' ? `/${entry.budgetMinutes}m` : ''
    parts.push(`elapsed=${elapsed(entry.createdAt)}${budget}`)
  }
  const progress = progressText(entry)
  if (progress.length > 0) parts.push(progress)
  if (entry.resumedFrom) parts.push(`resumedFrom=${entry.resumedFrom}`)
  if (entry.summary) parts.push(`result: ${entry.summary}`)
  return parts.join(' | ')
}

/**
 * Build the final worker brief: caller text, optional resume handoff, and the
 * dispatcher-injected verification/budget section.
 * @param {{brief: string, verification: 'quick'|'full', budgetMinutes: number|undefined, resumeEntry: Record<string, unknown>|undefined}} input
 */
function buildBrief({ brief, verification, budgetMinutes, resumeEntry }) {
  const sections = [brief]
  if (resumeEntry !== undefined) {
    const previous = typeof resumeEntry.summary === 'string' && resumeEntry.summary.trim().length > 0
      ? resumeEntry.summary.trim()
      : 'The previous dispatch left no result summary.'
    sections.push(
      [
        `## Resume handoff: ${String(resumeEntry.id)}`,
        previous,
        'Continue from this handoff. Do not redo work that the previous dispatch already completed; state any remaining step first.',
      ].join('\n'),
    )
  }
  const verificationLines = [
    '## Verification and budget (injected by the dispatcher)',
    verification === 'full'
      ? '- Verification level: full. Run the project\'s complete acceptance procedure (browser tour, screenshots, multi-viewport) as the project rules require.'
      : '- Verification level: quick. Run typecheck/build plus only the smallest check directly related to this change; do not run full browser tours, screenshots or multi-viewport checks unless this task explicitly needs interaction verification.',
  ]
  if (typeof budgetMinutes === 'number') {
    verificationLines.push(
      `- Budget: ${budgetMinutes} minutes. If the budget is exceeded, stop expanding work, keep the code that is complete, and report a handoff checklist (changed files, checks run, remaining items, risks) instead of retrying indefinitely.`,
    )
  }
  sections.push(verificationLines.join('\n'))
  return sections.join('\n\n')
}

/**
 * Resolve a dispatch id of the calling conversation to its recorded worker.
 * @param {{entry: Function}} board
 * @param {{id: unknown}} agent
 * @param {unknown} dispatchId
 * @param {string} toolName
 */
function requireDispatch(board, agent, dispatchId, toolName) {
  const id = typeof dispatchId === 'string' ? dispatchId.trim() : ''
  if (!id) throw new Error(`${toolName}: \`dispatch_id\` is required`)
  const entry = board.entry(String(agent.id), id)
  if (!entry) throw new Error(`${toolName}: unknown dispatch id "${id}" in this conversation`)
  if (!entry.childId) throw new Error(`${toolName}: dispatch "${id}" has no worker session yet`)
  return entry
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const board = ctx.dispatcherBoard

  ctx.effect(() => {
    const disposers = []

    disposers.push(
      ctx.tools.register({
        name: 'dispatch',
        description:
          'Delegate one self-contained task to a background worker and return immediately. The worker runs in its own session with a lean worker preset (execution/verification tools only; it cannot delegate further) and reports its final answer back into this conversation when it finishes. Use this for every implementation, investigation or verification request instead of doing the work here. Write `brief` as a complete work order (goal, exact scope, acceptance criteria and verification commands, constraints, report format); the dispatcher appends the verification/budget section and any resume handoff. `write_scopes` is enforced as a write lease: a dispatch that overlaps a pending/running dispatch in the same workspace is rejected unless `allow_overlap` is true. `verification` defaults to quick; set full only when the task really needs the complete acceptance procedure. `resume_of` continues an earlier dispatch from its summary. Several dispatches with disjoint scopes may be issued in one response; they run in parallel.',
        parameters: dispatchParameters,
        output: dispatchOutput,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) throw new Error('dispatch requires a calling agent')
          const title = typeof args?.title === 'string' ? args.title.trim() : ''
          const brief = typeof args?.brief === 'string' ? args.brief.trim() : ''
          if (!title) throw new Error('dispatch: `title` is required')
          if (!brief) throw new Error('dispatch: `brief` is required')
          const verification = args?.verification === 'full' ? 'full' : DEFAULT_VERIFICATION
          if (args?.verification !== undefined && args.verification !== 'quick' && args.verification !== 'full') {
            throw new Error('dispatch: `verification` must be "quick" or "full"')
          }
          const budgetMinutes = args?.budget_minutes
          if (budgetMinutes !== undefined && (!Number.isInteger(budgetMinutes) || budgetMinutes <= 0)) {
            throw new Error('dispatch: `budget_minutes` must be a positive integer')
          }
          const writeScopes = Array.isArray(args?.write_scopes)
            ? args.write_scopes.filter((scope) => typeof scope === 'string' && scope.trim().length > 0)
            : []
          const cwd = typeof args?.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : undefined
          const sessionId = String(parent.id)
          const workspace = typeof parent.session?.header?.cwd === 'string' ? parent.session.header.cwd : ''

          let resumeEntry
          const resumeOf = typeof args?.resume_of === 'string' ? args.resume_of.trim() : ''
          if (resumeOf.length > 0) {
            resumeEntry = board.entry(sessionId, resumeOf)
            if (resumeEntry === undefined) throw new Error(`dispatch: unknown resume_of dispatch id "${resumeOf}" in this conversation`)
          }

          if (args?.allow_overlap !== true) {
            const conflicts = board.findConflicts({ workspace, writeScopes })
            if (conflicts.length > 0) {
              const lines = conflicts.map(
                (conflict) =>
                  `- ${conflict.dispatchId} "${conflict.title}" (worker ${conflict.workerId || 'not started'}; overlapping scopes: ${conflict.scopes.join(', ')})`,
              )
              throw new Error(
                `dispatch: write-scope conflict with pending/running work in this workspace:\n${lines.join('\n')}\n` +
                  'Wait for those dispatches to finish, split the scopes, or pass `allow_overlap: true` if the overlap is intentional.',
              )
            }
          }

          const finalBrief = buildBrief({ brief, verification, budgetMinutes, resumeEntry })
          const entry = await board.create({
            sessionId,
            title,
            brief: finalBrief,
            writeScopes,
            cwd,
            workspace,
            verification,
            budgetMinutes,
            resumedFrom: resumeOf,
          })
          let activation
          try {
            activation = await ctx.subagents.startActivation({
              provider: 'spawn',
              label: title,
              request: {
                prompt: [{ type: 'text', text: finalBrief }],
                parent,
                agentPreset: WORKER_PRESET,
                maxDepth: WORKER_MAX_DEPTH,
                ...(cwd === undefined ? {} : { cwd }),
              },
              signal: exec.signal,
              delivery: 'parent',
            })
          } catch (error) {
            const message = error && typeof error.message === 'string' ? error.message : String(error)
            await board.fail(sessionId, entry.id, `worker start failed: ${message}`)
            throw error
          }

          const childId = String(activation.childId)
          await board.running(sessionId, entry.id, childId)
          Promise.resolve(activation.result).then(
            (result) => {
              void board.finish(sessionId, entry.id, result)
            },
            (error) => {
              const message = error && typeof error.message === 'string' ? error.message : String(error)
              void board.fail(sessionId, entry.id, message)
            },
          )
          return { dispatchId: entry.id, childId, status: 'running' }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'dispatch_update',
        description:
          'Send a steering message to one dispatched worker, addressed by its dispatch id. The message is delivered at the worker\'s next step boundary (a running tool call is not interrupted) and an inactive worker is resumed. Use this instead of `send_message`: in profiles with Agent Teams that tool addresses teammates by name and cannot reach a dispatched worker.',
        parameters: updateParameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              dispatchId: { type: 'string' },
              workerId: { type: 'string' },
              messageId: { type: 'string' },
            },
            required: ['dispatchId', 'workerId', 'messageId'],
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `message accepted for ${value.dispatchId} (worker ${value.workerId}); it lands at the worker's next step boundary`,
            },
          ],
        },
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) throw new Error('dispatch_update requires a calling agent')
          const message = typeof args?.message === 'string' ? args.message.trim() : ''
          if (!message) throw new Error('dispatch_update: `message` is required')
          const entry = requireDispatch(board, parent, args?.dispatch_id, 'dispatch_update')
          const messageId = await ctx.subagents.sendMessage(parent, entry.childId, [{ type: 'text', text: message }], {
            signal: exec.signal,
          })
          return { dispatchId: entry.id, workerId: entry.childId, messageId: String(messageId) }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'dispatch_stop',
        description:
          'Stop the current turn of one dispatched worker, addressed by its dispatch id. Queued messages and the worker session are preserved; send a new instruction with dispatch_update afterwards to resume. Use this instead of `interrupt_agent`, which addresses teammates by name in Agent Teams profiles.',
        parameters: stopParameters,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              dispatchId: { type: 'string' },
              workerId: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            required: ['dispatchId', 'workerId', 'accepted'],
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `stop requested for ${value.dispatchId} (worker ${value.workerId}); the worker may keep running until it observes the cancel signal`,
            },
          ],
        },
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) throw new Error('dispatch_stop requires a calling agent')
          const entry = requireDispatch(board, parent, args?.dispatch_id, 'dispatch_stop')
          ctx.subagents.interrupt(entry.childId, { kind: 'ancestor', agent: parent })
          return { dispatchId: entry.id, workerId: entry.childId, accepted: true }
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'dispatch_workers',
        description:
          'List the pending/running dispatched workers of this conversation with their dispatch id, worker session id, verification/budget, elapsed time, write scopes and live progress (current step, last tool, last activity). Use it to see what is still in flight before dispatching conflicting work or steering a worker.',
        parameters: workersParameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(_args, exec) {
          const agent = exec.agent
          if (!agent) throw new Error('dispatch_workers requires a calling agent')
          const entries = board.active(String(agent.id))
          if (entries.length === 0) return 'No pending or running dispatches.'
          return entries.map(formatEntry).join('\n')
        },
      }),
    )

    disposers.push(
      ctx.tools.register({
        name: 'dispatcher_board',
        description:
          'List the durable dispatch board of this conversation: dispatch id, status, worker session id, title, verification/budget, write scopes, elapsed time, live progress and result summary. Use it when you need the authoritative list of dispatched work, for example after a long gap or before reporting progress to the user.',
        parameters: boardParameters,
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const agent = exec.agent
          if (!agent) throw new Error('dispatcher_board requires a calling agent')
          const filter = typeof args?.status === 'string' ? args.status : ''
          const entries = board.list(String(agent.id)).filter((entry) => filter === '' || entry.status === filter)
          if (entries.length === 0) return 'The dispatch board is empty.'
          return entries.map(formatEntry).join('\n')
        },
      }),
    )

    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
