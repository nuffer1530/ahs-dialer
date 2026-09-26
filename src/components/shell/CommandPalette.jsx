import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './icons'

// ⌘K / Ctrl+K: jump to any page you can open, run a quick action (status,
// theme, sign out), or — with searchCustomers — find a ServiceTitan customer
// by name, phone or address and open them in the dialer (stage 3).
// items: [{ id, label, group, hint?, keywords?, icon?, run }].
export default function CommandPalette({ open, onClose, items, searchCustomers, onPickCustomer }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [custs, setCusts] = useState([])
  const [custBusy, setCustBusy] = useState(false)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => { if (open) { setQ(''); setSel(0); setCusts([]); setTimeout(() => inputRef.current?.focus(), 0) } }, [open])

  // Customers: 3+ characters, debounced, newest query wins.
  useEffect(() => {
    const term = q.trim()
    if (!open || !searchCustomers || term.length < 3) { setCusts([]); setCustBusy(false); return }
    let dead = false
    setCustBusy(true)
    const t = setTimeout(() => {
      searchCustomers(term).then(list => { if (!dead) setCusts(list || []) }).catch(() => { if (!dead) setCusts([]) })
        .finally(() => { if (!dead) setCustBusy(false) })
    }, 300)
    return () => { dead = true; clearTimeout(t) }
  }, [q, open, searchCustomers])

  const results = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hay = (it) => `${it.label} ${it.group} ${it.keywords || ''}`.toLowerCase()
    const pages = items.filter(it => words.every(w => hay(it).includes(w))).slice(0, 40)
    const people = custs.map(c => ({
      id: `cust:${c.id}`, label: c.name || 'Customer', group: 'Customers in ServiceTitan', icon: 'user',
      hint: [c.phone, c.city].filter(Boolean).join(' · '), run: () => onPickCustomer?.(c),
    }))
    return [...pages, ...people]
  }, [q, items, custs, onPickCustomer])
  useEffect(() => { setSel(0) }, [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!open) return null
  const run = (it) => { onClose(); it.run() }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) run(results[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  let lastGroup = null
  return (
    <div onMouseDown={onClose} style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(13,16,19,.42)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div role="dialog" aria-modal="true" aria-label="Search or jump to" onMouseDown={e => e.stopPropagation()} className="pop"
        style={{ width: 600, maxWidth: 'calc(100vw - 24px)', maxHeight: '70vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRadius: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="search" size={18} style={{ color: 'var(--text-muted)' }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder={searchCustomers ? 'Jump to a page, run an action, or find a customer…' : 'Jump to a page or run an action…'} aria-label="Search pages, actions and customers"
            role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-activedescendant={results[sel] ? `cmdk-${results[sel].id}` : undefined}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', font: 'inherit', fontSize: 16, color: 'var(--text-primary)' }} />
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 6px' }}>esc</span>
        </div>
        <div id="cmdk-list" ref={listRef} role="listbox" style={{ overflowY: 'auto', padding: '6px 0' }}>
          {!results.length && !custBusy && <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--text-muted)' }}>Nothing matches “{q}”.</div>}
          {results.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            return (
              <div key={it.id}>
                {head && <div className="pop-label" style={{ paddingTop: i ? 10 : 4 }}>{head}</div>}
                <div id={`cmdk-${it.id}`} data-idx={i} role="option" aria-selected={i === sel} className="pop-item" data-active={i === sel}
                  onMouseMove={() => setSel(i)} onClick={() => run(it)} style={{ padding: '9px 16px' }}>
                  <Icon name={it.icon || 'arrowRight'} size={15} style={{ color: 'var(--text-muted)' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>{it.label}</span>
                  {it.hint && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{it.hint}</span>}
                </div>
              </div>
            )
          })}
          {custBusy && <div style={{ padding: '10px 16px', fontSize: 12.5, color: 'var(--text-muted)' }}>Searching ServiceTitan…</div>}
        </div>
      </div>
    </div>
  )
}
