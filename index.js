/**
 * Host half of the dispatcher bundle.
 *
 * Owns the durable dispatch board (write-scope leases, restart reconciliation,
 * live per-worker progress) and serves it to the Web client over an
 * authenticated same-origin route. This module imports nothing but Node
 * builtins, so the bundle has no runtime dependency to install.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dispatcher-host'
export const inject = ['connection', 'agents']

const BOARD_VERSION = 1
const MAX_ENTRIES_PER_SESSION = 200
const LAST_TEXT_LIMIT = 240
const ROUTE_PATH = '/api/dispatcher.board'

/** @returns {string} the DeepSeek Harness home directory. */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** @returns {string} absolute path of the board JSON file. */
function boardFilePath() {
  return path.join(dshHome(), 'storages', 'dispatcher', 'board.json')
}

/** @returns {{version:number, sessions: Record<string, Array<Record<string, unknown>>>}} */
function emptyState() {
  return { version: BOARD_VERSION, sessions: {} }
}

/** Normalize a workspace-relative write scope for prefix comparison. */
function normalizeScope(scope) {
  if (typeof scope !== 'string') return ''
  let value = scope.trim().replaceAll('\\', '/')
  while (value.startsWith('./')) value = value.slice(2)
  return value.replace(/\/+$/u, '')
}

/** Normalize an absolute workspace path for equality comparison. */
function normalizeWorkspace(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

/** Whether two normalized scope prefixes overlap (equal or nested). */
function scopesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Load the persisted board, tolerating a missing or unreadable file.
 * @param {string} file
 */
function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.version === BOARD_VERSION && parsed.sessions && typeof parsed.sessions === 'object') return parsed
  } catch (error) {
    if (error && error.code !== 'ENOENT') console.warn(`[dispatcher] board read failed: ${error?.message ?? error}`)
  }
  return emptyState()
}

/**
 * Atomically persist the board. Failures are logged and never break a tool call.
 * @param {string} file
 * @param {ReturnType<typeof emptyState>} state
 */
function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2))
    fs.renameSync(temporary, file)
  } catch (error) {
    console.warn(`[dispatcher] board write failed: ${error?.message ?? error}`)
  }
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {Record<string, unknown>} result a subagent settlement result
 */
function summarizeResult(result) {
  const output = Array.isArray(result?.output) ? result.output : []
  const text = output
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  const diagnostic = typeof result?.diagnostic === 'string' ? result.diagnostic.trim() : ''
  const combined = [text, diagnostic].filter(Boolean).join('\n\n')
  return combined.length > 1200 ? `${combined.slice(0, 1200)}…` : combined
}

/** Extract a short assistant text snippet from a message content array. */
function snippetOf(content) {
  const blocks = Array.isArray(content) ? content : []
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text.length > LAST_TEXT_LIMIT ? `${text.slice(0, LAST_TEXT_LIMIT)}…` : text
}

/** @returns {'quick'|'full'} */
function workerVerification(value) {
  return value === 'full' ? 'full' : 'quick'
}

/**
 * Durable board per dispatcher session, plus process-local worker progress.
 * @param {string} file
 */
function createBoard(file) {
  const state = loadState(file)
  const persist = () => saveState(file, state)

  /** @type {Map<string, Record<string, unknown>>} child session id -> runtime progress */
  const progressByChild = new Map()
  /** @type {Map<string, {sessionId: string, entryId: string}>} child session id -> owning entry */
  const childIndex = new Map()

  /** @param {string} sessionId */
  function sessionEntries(sessionId) {
    let entries = state.sessions[sessionId]
    if (!Array.isArray(entries)) {
      entries = []
      state.sessions[sessionId] = entries
    }
    return entries
  }

  /** @param {Array<Record<string, unknown>>} entries */
  function nextId(entries) {
    let maximum = 0
    for (const entry of entries) {
      const match = /^d(\d+)$/u.exec(typeof entry.id === 'string' ? entry.id : '')
      if (match) maximum = Math.max(maximum, Number(match[1]))
    }
    return `d${maximum + 1}`
  }

  function findEntry(sessionId, id) {
    return sessionEntries(sessionId).find((entry) => entry.id === id)
  }

  function indexChild(sessionId, entry) {
    if (typeof entry.childId === 'string' && entry.childId.length > 0) {
      childIndex.set(entry.childId, { sessionId, entryId: entry.id })
    }
  }

  function dropChild(childId) {
    if (typeof childId !== 'string' || childId.length === 0) return
    childIndex.delete(childId)
    progressByChild.delete(childId)
  }

  /** Attach live progress to a detached entry view. */
  function withProgress(entry) {
    const copy = clone(entry)
    if (typeof entry.childId === 'string' && entry.childId.length > 0) {
      const progress = progressByChild.get(entry.childId)
      if (progress !== undefined) copy.progress = clone(progress)
    }
    return copy
  }

  function trim(entries) {
    if (entries.length <= MAX_ENTRIES_PER_SESSION) return
    entries.splice(0, entries.length - MAX_ENTRIES_PER_SESSION)
  }

  return {
    /**
     * @param {{sessionId: string, title: string, brief: string, writeScopes?: string[], cwd?: string, workspace?: string, verification?: string, budgetMinutes?: number, resumedFrom?: string}} input
     */
    async create(input) {
      const entries = sessionEntries(input.sessionId)
      const now = Date.now()
      const writeScopes = Array.isArray(input.writeScopes)
        ? [...new Set(input.writeScopes.map(normalizeScope).filter((scope) => scope.length > 0))]
        : []
      const entry = {
        id: nextId(entries),
        sessionId: input.sessionId,
        title: input.title,
        brief: input.brief,
        writeScopes,
        workspace: normalizeWorkspace(input.workspace),
        cwd: typeof input.cwd === 'string' ? input.cwd : '',
        verification: workerVerification(input.verification),
        budgetMinutes: typeof input.budgetMinutes === 'number' ? input.budgetMinutes : null,
        resumedFrom: typeof input.resumedFrom === 'string' ? input.resumedFrom : '',
        childId: '',
        status: 'pending',
        createdAt: now,
        startedAt: null,
        endedAt: null,
        summary: '',
        stopReason: '',
      }
      entries.push(entry)
      trim(entries)
      persist()
      return clone(entry)
    },

    /**
     * @param {string} sessionId
     * @param {string} id
     * @param {string} childId
     */
    async running(sessionId, id, childId) {
      const entry = findEntry(sessionId, id)
      if (!entry) return undefined
      entry.status = 'running'
      entry.childId = childId
      entry.startedAt = Date.now()
      indexChild(sessionId, entry)
      progressByChild.set(childId, { toolCalls: 0, lastActivityAt: entry.startedAt })
      persist()
      return withProgress(entry)
    },

    /**
     * @param {string} sessionId
     * @param {string} id
     * @param {Record<string, unknown>} result
     */
    async finish(sessionId, id, result) {
      const entry = findEntry(sessionId, id)
      if (!entry) return undefined
      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : ''
      entry.status = stopReason === 'completed' ? 'done' : stopReason === 'aborted' ? 'stopped' : 'failed'
      entry.stopReason = stopReason
      entry.summary = summarizeResult(result)
      entry.endedAt = Date.now()
      dropChild(entry.childId)
      persist()
      return clone(entry)
    },

    /**
     * @param {string} sessionId
     * @param {string} id
     * @param {string} message
     */
    async fail(sessionId, id, message) {
      const entry = findEntry(sessionId, id)
      if (!entry) return undefined
      entry.status = 'failed'
      entry.stopReason = 'error'
      entry.summary = message
      entry.endedAt = Date.now()
      dropChild(entry.childId)
      persist()
      return clone(entry)
    },

    /** @param {string} sessionId @param {string} id */
    entry(sessionId, id) {
      const found = findEntry(sessionId, id)
      return found === undefined ? undefined : withProgress(found)
    },

    /** @param {string} sessionId */
    list(sessionId) {
      return [...sessionEntries(sessionId)].reverse().map(withProgress)
    },

    /** Active (pending or running) entries of one session. */
    active(sessionId) {
      return sessionEntries(sessionId)
        .filter((entry) => entry.status === 'pending' || entry.status === 'running')
        .map(withProgress)
    },

    /**
     * Running/pending dispatches whose write scopes overlap the requested
     * scopes in the same workspace. Empty scopes mean "read-only" and never conflict.
     * @param {{workspace: string, writeScopes: string[]}} request
     */
    findConflicts({ workspace, writeScopes }) {
      const wanted = Array.isArray(writeScopes) ? writeScopes.map(normalizeScope).filter(Boolean) : []
      const workspaceKey = normalizeWorkspace(workspace)
      if (wanted.length === 0 || workspaceKey.length === 0) return []
      const conflicts = []
      for (const [sessionId, entries] of Object.entries(state.sessions)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (entry.status !== 'pending' && entry.status !== 'running') continue
          if (normalizeWorkspace(entry.workspace) !== workspaceKey) continue
          const scopes = Array.isArray(entry.writeScopes) ? entry.writeScopes.map(normalizeScope).filter(Boolean) : []
          const hits = []
          for (const left of wanted) {
            for (const right of scopes) if (scopesOverlap(left, right)) hits.push(left)
          }
          if (hits.length === 0) continue
          conflicts.push({
            dispatchId: entry.id,
            sessionId,
            title: entry.title,
            workerId: typeof entry.childId === 'string' ? entry.childId : '',
            scopes: [...new Set(hits)],
          })
        }
      }
      return conflicts
    },

    /**
     * Mark persisted pending/running entries whose child no longer exists as
     * unknown instead of letting a restart leave them "running" forever.
     * @param {(childId: string) => boolean} isLive
     */
    reconcile(isLive) {
      let changed = false
      const now = Date.now()
      for (const entries of Object.values(state.sessions)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          if (entry.status !== 'pending' && entry.status !== 'running') continue
          const childId = typeof entry.childId === 'string' ? entry.childId : ''
          if (childId.length > 0) {
            let live = false
            try {
              live = isLive(childId)
            } catch {
              live = false
            }
            if (live) {
              indexChild(entry.sessionId, entry)
              continue
            }
          }
          entry.status = 'unknown'
          entry.stopReason = 'host-restarted'
          entry.endedAt = now
          if (!entry.summary) entry.summary = 'Host restarted before this dispatch reported a result.'
          changed = true
        }
      }
      if (changed) persist()
    },

    /**
     * Fold one durable session event of a worker session into its live progress.
     * @param {string} sessionId the emitting (child) session id
     * @param {{type?: string, data?: Record<string, unknown>}} event
     */
    observeChildEvent(sessionId, event) {
      const childId = String(sessionId)
      if (!childIndex.has(childId)) return
      const now = Date.now()
      let progress = progressByChild.get(childId)
      if (progress === undefined) {
        progress = { toolCalls: 0 }
        progressByChild.set(childId, progress)
      }
      progress.lastActivityAt = now
      const type = typeof event?.type === 'string' ? event.type : ''
      const data = event?.data && typeof event.data === 'object' ? event.data : {}
      if (type === 'turn/start' || type === 'turn/end') {
        if (typeof data.turn === 'number') progress.turn = data.turn
      } else if (type === 'step/start') {
        if (typeof data.turn === 'number') progress.turn = data.turn
        if (typeof data.step === 'number') progress.step = data.step
      } else if (type === 'tool/call') {
        if (typeof data.name === 'string') {
          progress.lastTool = data.name
          progress.lastToolAt = now
        }
        progress.toolCalls = (typeof progress.toolCalls === 'number' ? progress.toolCalls : 0) + 1
      } else if (type === 'assistant/message') {
        const message = data.message && typeof data.message === 'object' ? data.message : {}
        const snippet = snippetOf(message.content)
        if (snippet.length > 0) progress.lastText = snippet
      }
    },

    /** @param {string} sessionId */
    view(sessionId) {
      const entries = [...sessionEntries(sessionId)].reverse().map(withProgress)
      const counts = { total: entries.length, pending: 0, running: 0, done: 0, failed: 0, stopped: 0, unknown: 0 }
      for (const entry of entries) {
        if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1
      }
      return { sessionId, entries, counts }
    },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  if (!ctx.get('connection')) {
    ctx.logger?.warn?.('[dispatcher] connection service unavailable; the dispatch board route is disabled')
    return
  }
  const file = boardFilePath()
  const board = createBoard(file)
  board.reconcile((childId) => ctx.agents.get(childId) !== undefined)
  ctx.provide('dispatcherBoard', board)
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      try {
        board.observeChildEvent(String(session.id), event)
      } catch (error) {
        ctx.logger?.warn?.(`[dispatcher] progress update failed: ${error?.message ?? error}`)
      }
    }),
  )
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => {
        let sessionId = ''
        try {
          sessionId = new URL(request.url).searchParams.get('session') || ''
        } catch {
          sessionId = ''
        }
        if (!sessionId) {
          return Promise.resolve(Response.json({ error: 'session-required' }, { status: 400, headers: { 'cache-control': 'no-store' } }))
        }
        return Promise.resolve(Response.json(board.view(sessionId), { headers: { 'cache-control': 'no-store' } }))
      },
    }),
  )
  ctx.logger?.info?.(`[dispatcher] board file ${file}`)
}
