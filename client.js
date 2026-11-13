/**
 * Browser half of the dispatcher bundle.
 *
 * Renders a compact dispatch board above the composer for the current session,
 * polling the Host's authenticated `api/dispatcher.board` route. Renders
 * nothing until the session has at least one dispatch, so ordinary
 * conversations are unaffected.
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-dispatcher',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dispatcher'

    const zh = {
      'board.title': '调度看板',
      'board.expand': '展开',
      'board.collapse': '收起',
      'board.running': '运行中',
      'board.done': '已完成',
      'board.failed': '失败',
      'board.stopped': '已停止',
      'board.pending': '排队中',
      'board.scope': '写域',
      'board.worker': 'worker',
      'board.empty': '暂无调度',
      'status.running': '运行中',
      'status.done': '已完成',
      'status.failed': '失败',
      'status.stopped': '已停止',
      'status.pending': '排队中',
    }
    const en = {
      'board.title': 'Dispatches',
      'board.expand': 'Expand',
      'board.collapse': 'Collapse',
      'board.running': 'running',
      'board.done': 'done',
      'board.failed': 'failed',
      'board.stopped': 'stopped',
      'board.pending': 'queued',
      'board.scope': 'scope',
      'board.worker': 'worker',
      'board.empty': 'No dispatches yet',
      'status.running': 'Running',
      'status.done': 'Done',
      'status.failed': 'Failed',
      'status.stopped': 'Stopped',
      'status.pending': 'Queued',
    }

    const STATUS_COLOR = {
      running: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))',
      done: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      stopped: 'var(--dsw-alias-state-warn-primary)',
      pending: 'var(--dsw-alias-state-idle-primary)',
    }

    function statusLabel(t, status) {
      const key = `status.${status}`
      const label = t(key)
      return typeof label === 'string' && label !== key ? label : status
    }

    function duration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`
      if (ms < 3600000) return `${Math.round(ms / 60000)}m`
      return `${(ms / 3600000).toFixed(1)}h`
    }

    function DispatchBoard({ sessionId, t }) {
      const [open, setOpen] = React.useState(false)
      const [board, setBoard] = React.useState({ entries: [], counts: null, ready: false })

      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        let timer
        const load = () => {
          fetch(`api/dispatcher.board?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((value) => {
              if (!alive) return
              setBoard({
                entries: Array.isArray(value && value.entries) ? value.entries : [],
                counts: (value && value.counts) || null,
                ready: true,
              })
            })
            .catch(() => {
              if (alive) setBoard((current) => (current.ready ? current : { entries: [], counts: null, ready: true }))
            })
        }
        load()
        timer = setInterval(load, 2000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      const entries = board.entries
      if (!board.ready || entries.length === 0) return null

      const counts = board.counts || { running: 0, done: 0, failed: 0, stopped: 0, pending: 0, total: entries.length }
      const badge = (label, value, color) =>
        h(
          'span',
          {
            key: label,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              color: 'var(--dsw-alias-label-secondary)',
              whiteSpace: 'nowrap',
            },
          },
          h('span', {
            style: { width: '6px', height: '6px', borderRadius: '50%', background: color, display: 'inline-block' },
          }),
          `${label} ${value}`,
        )

      return h(
        'section',
        {
          style: {
            border: '0.5px solid var(--dsw-alias-border-l1)',
            borderRadius: 'var(--dsw-radius-lg, 10px)',
            background: 'var(--dsw-alias-bg-layer-1)',
            margin: '2px 0 0',
            padding: '6px 10px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)',
          },
        },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open ? 'true' : 'false',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              width: '100%',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
            },
          },
          h(
            'span',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', minWidth: 0 } },
            h(
              'span',
              {
                style: {
                  color: 'var(--dsw-alias-label-primary)',
                  fontWeight: 600,
                  fontSize: '12px',
                },
              },
              t('board.title'),
            ),
            counts.running > 0 && badge(t('board.running'), counts.running, STATUS_COLOR.running),
            counts.done > 0 && badge(t('board.done'), counts.done, STATUS_COLOR.done),
            counts.failed > 0 && badge(t('board.failed'), counts.failed, STATUS_COLOR.failed),
            counts.stopped > 0 && badge(t('board.stopped'), counts.stopped, STATUS_COLOR.stopped),
            counts.pending > 0 && badge(t('board.pending'), counts.pending, STATUS_COLOR.pending),
          ),
          h('span', { style: { flexShrink: 0, color: 'var(--dsw-alias-label-secondary)' } }, open ? t('board.collapse') : t('board.expand')),
        ),
        open &&
          h(
            'ul',
            {
              style: {
                listStyle: 'none',
                margin: '8px 0 0',
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                maxHeight: '260px',
                overflowY: 'auto',
              },
            },
            entries.slice(0, 30).map((entry) =>
              h(
                'li',
                {
                  key: entry.id,
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                    padding: '6px 8px',
                    borderRadius: 'var(--dsw-radius-sm, 8px)',
                    background: 'var(--dsw-alias-bg-layer-2)',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
                  h('span', {
                    style: {
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: STATUS_COLOR[entry.status] || STATUS_COLOR.pending,
                    },
                  }),
                  h(
                    'span',
                    {
                      style: {
                        color: 'var(--dsw-alias-label-primary)',
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      title: entry.title,
                    },
                    entry.title,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        marginLeft: 'auto',
                        flexShrink: 0,
                        color: 'var(--dsw-alias-label-secondary)',
                        fontVariantNumeric: 'tabular-nums',
                      },
                    },
                    `#${entry.id} · ${statusLabel(t, entry.status)}` +
                      (entry.status === 'running' ? ` · ${duration(Date.now() - entry.createdAt)}` : ''),
                  ),
                ),
                Array.isArray(entry.writeScopes) && entry.writeScopes.length > 0
                  ? h(
                      'div',
                      { style: { color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      `${t('board.scope')}: ${entry.writeScopes.join(', ')}`,
                    )
                  : null,
                entry.summary
                  ? h(
                      'div',
                      {
                        style: {
                          color: 'var(--dsw-alias-label-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                        title: entry.summary,
                      },
                      entry.summary,
                    )
                  : null,
              ),
            ),
          ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dispatcher: dictionaries')
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'dispatcher-board',
              order: 40,
              locale: NS,
            },
            DispatchBoard,
          ),
        )
      },
    }
  },
})
