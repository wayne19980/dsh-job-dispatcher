/**
 * Preset-scoped half of the dispatcher bundle: the model-facing `dispatch`
 * and `dispatcher_board` tools for the `dispatcher` agent preset.
 *
 * The definitions are raw JSON Schema and the worker is started through the
 * injected Host subagent service, so this module needs no package imports.
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
        'Complete, self-contained work order for the worker. The worker cannot see this conversation, so include the goal, exact files/pages/modules in scope, acceptance criteria, verification commands, project constraints, and the report format.',
    },
    write_scopes: {
      type: 'array',
      description:
        'Workspace-relative files or directories this task is expected to modify. Used only for the advisory conflict display on the dispatch board.',
      items: { type: 'string' },
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
      description: 'Optional status filter: pending, running, done, failed or stopped.',
    },
  },
}

const STATUS_LABEL = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

/** @param {Record<string, unknown>} entry */
function formatEntry(entry) {
  const parts = [`[${entry.id}] ${STATUS_LABEL[entry.status] ?? entry.status} ${entry.title}`]
  if (entry.childId) parts.push(`worker=${entry.childId}`)
  if (Array.isArray(entry.writeScopes) && entry.writeScopes.length > 0) parts.push(`scope=${entry.writeScopes.join(',')}`)
  if (entry.summary) parts.push(`result: ${entry.summary}`)
  return parts.join(' | ')
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const board = ctx.dispatcherBoard

  ctx.effect(() => {
    const disposeDispatch = ctx.tools.register({
      name: 'dispatch',
      description:
        'Delegate one self-contained task to a background worker and return immediately. The worker runs in its own session with the full standard toolset and reports its final answer back into this conversation when it finishes. Use this for every implementation, investigation or verification request instead of doing the work here. Write `brief` as a complete work order (goal, exact scope, acceptance criteria and verification commands, constraints, report format). Several independent dispatches may be issued in one response; they run in parallel.',
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

        const entry = await board.create({ sessionId, title, brief, writeScopes, cwd })
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
    })

    const disposeBoard = ctx.tools.register({
      name: 'dispatcher_board',
      description:
        'List the durable dispatch board of this conversation: dispatch id, status, worker session id, title, write scopes and result summary. Use it when you need the authoritative list of dispatched work, for example after a long gap or before reporting progress to the user.',
      parameters: boardParameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('dispatcher_board requires a calling agent')
        const filter = typeof args?.status === 'string' ? args.status : ''
        const entries = board
          .list(String(agent.id))
          .filter((entry) => filter === '' || entry.status === filter)
        if (entries.length === 0) return 'The dispatch board is empty.'
        return entries.map(formatEntry).join('\n')
      },
    })

    return () => {
      disposeDispatch()
      disposeBoard()
    }
  })
}
