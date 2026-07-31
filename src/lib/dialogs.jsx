import { useState, useEffect } from 'react'

// In-app toasts + confirm dialogs — replaces the browser's native alert()
// and window.confirm() ("andi.awesomeservice.com says…"), the last thing in
// the app that looked like a web page instead of software.
//
//   toast('Could not load this recording.')                  // error (default)
//   toast('Saved', { type: 'success' })
//   if (await confirmDlg('Delete this article?', { danger: true })) …
//
// DialogHost mounts once in the app shell. If it isn't mounted (early boot),
// confirmDlg falls back to window.confirm so nothing ever silently no-ops.

let _pushToast = null
let _pushConfirm = null

export function toast(msg, opts = {}) {
  if (_pushToast) _pushToast({ msg: String(msg), type: opts.type || 'error' })
  else console.warn('toast (no host):', msg)
}

export function confirmDlg(msg, opts = {}) {
  return new Promise(resolve => {
    if (!_pushConfirm) return resolve(window.confirm(msg))
    _pushConfirm({ msg: String(msg), title: opts.title || 'Are you sure?', confirmLabel: opts.confirmLabel || 'Confirm', danger: !!opts.danger, resolve })
  })
}

const EDGE = { error: 'var(--danger)', success: 'var(--success)', info: '#ff751f' }

export function DialogHost() {
  const [toasts, setToasts] = useState([])
  const [confirm, setConfirm] = useState(null)

  useEffect(() => {
    _pushToast = (t) => {
      const id = Math.random().toString(36).slice(2)
      setToasts(prev => [...prev.slice(-3), { ...t, id }])
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), t.type === 'success' ? 4000 : 6500)
    }
    _pushConfirm = (c) => setConfirm(c)
    return () => { _pushToast = null; _pushConfirm = null }
  }, [])

  const settle = (ok) => {
    confirm?.resolve(ok)
    setConfirm(null)
  }

  return (
    <>
      {/* Toast stack — top center, under any incoming-call banner */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', top: 78, left: '50%', transform: 'translateX(-50%)', zIndex: 2400, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
          {toasts.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 480, minWidth: 260,
              background: '#111318', color: '#ececee', borderRadius: 12, padding: '11px 14px',
              borderLeft: `3px solid ${EDGE[t.type] || EDGE.error}`,
              boxShadow: '0 12px 36px rgba(0,0,0,.4)' }}>
              <svg width="16" height="16" viewBox="0 0 64 64" style={{ flexShrink: 0 }} xmlns="http://www.w3.org/2000/svg">
                <polyline points="9,32 19,32 25,17 33,47 40,26 45,32 55,32" fill="none" stroke="#ff751f" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <div style={{ fontSize: 12.5, lineHeight: 1.45, flex: 1 }}>{t.msg}</div>
              <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
                style={{ border: 'none', background: 'transparent', color: '#9a9aa2', cursor: 'pointer', fontSize: 14, padding: 2, flexShrink: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Confirm dialog */}
      {confirm && (
        <div onClick={() => settle(false)} style={{ position: 'fixed', inset: 0, zIndex: 2500, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 400, maxWidth: '92vw', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', boxShadow: '0 24px 70px rgba(0,0,0,.45)' }}>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: 'var(--text-primary)', marginBottom: 8 }}>{confirm.title}</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', marginBottom: 18, whiteSpace: 'pre-wrap' }}>{confirm.msg}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => settle(false)}>Cancel</button>
              <button onClick={() => settle(true)}
                style={{ padding: '8px 20px', borderRadius: 'var(--radius)', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#fff',
                  background: confirm.danger ? 'var(--danger)' : 'var(--accent)' }}>
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
