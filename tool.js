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

/** Workers always run the full standard preset, never this read-only one. */
const WORKER_PRESET = 'standard'
/** Allow a dispatcher that is itself a child session to still start a worker. */
const WORKER_MAX_DEPTH = 2

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
        'Complete, self-contained work order for the worker. The worker cannot see this conversation, so include the goal, exact files/modules in scope, acceptance criteria, verification commands, project constraints, and the report format.',
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

/** Format one elapsed duration for the board/worker listings. */
function elapsed(from, to = Date.now()) {
  const millis = typeof from === 'number' ? to - from : 0
  if (!Number.isFinite(millis) || millis < 0) return '?'
  if (millis < 60000) return `${Math.max(1, Math.round(millis / 1000))}s`
  if (millis < 3600000) return `${Math.round(millis / 60000)}m`
  return `${(millis / 3600000).toFixed(1)}h`
}

/** @param {Record<string, unknown>} entry */
function formatEntry(entry) {
  const parts = [`[${entry.id}] ${STATUS_LABEL[entry.status] ?? entry.status} ${entry.title}`]
  if (entry.childId) parts.push(`worker=${entry.childId}`)
  if (Array.isArray(entry.writeScopes) && entry.writeScopes.length > 0) parts.push(`scope=${entry.writeScopes.join(',')}`)
  if (entry.status === 'running' || entry.status === 'pending') parts.push(`elapsed=${elapsed(entry.createdAt)}`)
  if (entry.summary) parts.push(`result: ${entry.summary}`)
  return parts.join(' | ')
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
          'Delegate one self-contained task to a background worker and return immediately. The worker runs in its own session with the full standard toolset and reports its final answer back into this conversation when it finishes. Use this for every implementation, investigation or verification request instead of doing the work here. Write `brief` as a complete work order (goal, exact scope, acceptance criteria and verification commands, constraints, report format). `write_scopes` is enforced as a write lease: a dispatch that overlaps a pending/running dispatch in the same workspace is rejected unless `allow_overlap` is true. Several dispatches with disjoint scopes may be issued in one response; they run in parallel.',
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
          const writeScopes = Array.isArray(args?.write_scopes)
            ? args.write_scopes.filter((scope) => typeof scope === 'string' && scope.trim().length > 0)
            : []
          const cwd = typeof args?.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : undefined
          const sessionId = String(parent.id)
          const workspace = typeof parent.session?.header?.cwd === 'string' ? parent.session.header.cwd : ''

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

          const entry = await board.create({ sessionId, title, brief, writeScopes, cwd, workspace })
          let activation
          try {
            activation = await ctx.subagents.startActivation({
              provider: 'spawn',
              label: title,
              request: {
                prompt: [{ type: 'text', text: brief }],
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
          'List the pending/running dispatched workers of this conversation with their dispatch id, worker session id, elapsed time and write scopes. Use it to see what is still in flight before dispatching conflicting work or steering a worker.',
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
          'List the durable dispatch board of this conversation: dispatch id, status, worker session id, title, write scopes, elapsed time and result summary. Use it when you need the authoritative list of dispatched work, for example after a long gap or before reporting progress to the user.',
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
