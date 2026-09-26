import { useEffect, useMemo, useRef, useState } from 'react'
import { sb } from '../../lib/supabase'
import { SAMPLE_ROLES } from '../../lib/preview'
import { Icon } from './icons'

// "View as…" (admins): pick a person — or a sample role nobody holds yet —
// and Andi shows exactly what they'd see, read-only (lib/preview.js).

export const ROLE_NAMES = { admin: 'Admin', call_center_manager: 'Call center manager', ops_manager: 'Operations manager', dispatcher: 'Dispatcher', rep: 'CSR' }
const GROUPS = [['call_center_manager', 'Call center managers'], ['ops_manager', 'Operations managers'], ['dispatcher', 'Dispatchers'], ['rep', 'CSRs'], ['admin', 'Admins']]

export default function ViewAsPicker({ open, onClose, onPick, onExit, me, current }) {
  const [people, setPeople] = useState(null)
  const [q, setQ] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setQ('')
    setTimeout(() => inputRef.current?.focus(), 0)
    sb.from('profiles').select('*').eq('active', true).order('name').then(({ data }) => setPeople(data || []))
  }, [open])

  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (p) => words.every(w => `${p.name || ''} ${p.email || ''} ${ROLE_NAMES[p.role] || ''}`.toLowerCase().includes(w))
    return GROUPS.map(([role, label]) => {
      const rows = (people || []).filter(p => p.role === role && p.id !== me?.id && hit(p))
      // A sample for roles nobody holds (dispatcher today): the role's menus
      // and Home, with your own account's data behind it.
      const samples = SAMPLE_ROLES.filter(s => s.role === role && !(people || []).some(p => p.role === role))
        .filter(s => hit({ name: s.name, role }))
        .map(s => ({ ...me, role, name: s.name, home_view: null, inbound_skill: false, leads_teams: [], _sample: true, id: `sample-${role}` }))
      return { role, label, rows: [...rows, ...samples] }
    }).filter(g => g.rows.length)
  }, [people, q, me])

  if (!open) return null
  const pick = (p) => onPick(p._sample ? { ...p, id: me.id } : p)
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(13,16,19,.42)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '10vh' }}>
      <div role="dialog" aria-modal="true" aria-label="View Andi as" onMouseDown={e => e.stopPropagation()} className="pop"
        style={{ width: 520, maxWidth: 'calc(100vw - 24px)', maxHeight: '76vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 18 }}>
        <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="disp" style={{ fontSize: 17, fontWeight: 700 }}>View Andi as…</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>read-only — nothing you do in the preview is saved</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="search" size={16} style={{ color: 'var(--text-muted)' }} />
            <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && onClose()}
              placeholder="Find a person or role…" aria-label="Find a person or role"
              style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: 'inherit', fontSize: 15, color: 'var(--text-primary)' }} />
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '6px 0' }}>
          {!people ? <div style={{ padding: 16 }}><div className="skel" style={{ height: 120, borderRadius: 12 }} /></div>
            : !groups.length ? <div style={{ padding: '16px', fontSize: 13, color: 'var(--text-muted)' }}>Nobody matches “{q}”.</div>
            : groups.map(g => (
              <div key={g.role}>
                <div className="pop-label" style={{ paddingTop: 8 }}>{g.label}</div>
                {g.rows.map(p => (
                  <button key={p.id} type="button" className="pop-item" data-active={current && (current._sample ? current.role === p.role && p._sample : current.id === p.id)} onClick={() => pick(p)} style={{ padding: '9px 16px', width: '100%' }}>
                    <Icon name="user" size={15} style={{ color: 'var(--text-muted)' }} />
                    <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>{p.name || p.email}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p._sample ? 'no one has this role yet' : p.email}</span>
                  </button>
                ))}
              </div>
            ))}
        </div>
        {current && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onExit} style={{ borderRadius: 99 }}>Exit preview — back to me</button>
          </div>
        )}
      </div>
    </div>
  )
}
