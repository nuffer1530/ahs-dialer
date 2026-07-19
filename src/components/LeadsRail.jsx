import { useEffect, useState, useCallback } from 'react'
import { sb } from '../lib/supabase'

// The lead inbox rail. These are PAID leads (Angi ~$52 each) that competitors
// are calling too, so they sit above everything and jump the dial queue.
//
// This is an inbox, not a queue: clicking a lead claims it (so two reps can't
// both burn the same paid lead), promotes it to a real contact, and hands the
// contact id back so the normal dialer machinery takes over. The row then
// leaves the rail. Rows also leave on their own when the booking is dismissed
// or converted inside ServiceTitan — the server poller resolves them.

const ago = (iso) => {
  if (!iso) return ''
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// Anything that arrived outside working hours is backlog, not a live alert —
// Revin AI has already touched it and the rep works it in the morning.
const isOvernight = (iso) => {
  if (!iso) return false
  const h = new Date(iso).getHours()
  return h >= 18 || h < 7
}

export default function LeadsRail({ currentRep, onOpenContact }) {
  const [leads, setLeads] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const { data } = await sb.from('st_leads').select('*')
      .is('resolved_at', null).order('submitted_at', { ascending: false })
    setLeads(data || [])
  }, [])

  useEffect(() => {
    load()
    const ch = sb.channel('st_leads_rail')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'st_leads' }, load)
      .subscribe()
    // Timestamps are relative ("4m ago"), so re-render them as they age.
    const t = setInterval(() => setLeads(l => [...l]), 60_000)
    return () => { sb.removeChannel(ch); clearInterval(t) }
  }, [load])

  const work = async (lead) => {
    if (busyId) return
    setBusyId(lead.id); setErr('')
    try {
      if (!lead.claimed_by) {
        const r = await fetch(`/api/leads/${lead.id}/claim`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rep: currentRep }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) { setErr(d.error || 'Could not claim'); load(); return }
      } else if (lead.claimed_by !== currentRep) {
        setErr(`${lead.claimed_by} is working this lead.`); return
      }
      const p = await fetch(`/api/leads/${lead.id}/promote`, { method: 'POST' })
      const pd = await p.json().catch(() => ({}))
      if (!p.ok) { setErr(pd.error || 'Could not open lead'); load(); return }
      onOpenContact?.(pd.contactId)
    } catch (e) {
      setErr(e.message)
    } finally { setBusyId(null) }
  }

  return (
    <>
      <div style={{ padding: '9px 10px 7px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .8, color: 'var(--text-muted)' }}>Leads</span>
          {leads.length > 0 && (
            <span style={{ fontSize: 10, fontWeight: 700, background: 'var(--danger)', color: '#fff', borderRadius: 99, padding: '1px 7px' }}>
              {leads.length}
            </span>
          )}
        </div>
        <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
          Paid leads — work these first
        </div>
      </div>

      {err && (
        <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: 10, padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
          {err}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {leads.length === 0 && (
          <div style={{ padding: '22px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5 }}>
            No open leads.<br />
            <span style={{ fontSize: 10 }}>New ones appear here within a minute.</span>
          </div>
        )}

        {leads.map(lead => {
          const mine = lead.claimed_by === currentRep
          const takenByOther = lead.claimed_by && !mine
          const overnight = isOvernight(lead.submitted_at)
          return (
            <div key={lead.id} onClick={() => !takenByOther && work(lead)}
              title={takenByOther ? `${lead.claimed_by} is working this` : 'Claim and open this lead'}
              style={{
                padding: '9px 10px', borderBottom: '1px solid var(--border)',
                cursor: takenByOther ? 'not-allowed' : 'pointer',
                opacity: takenByOther ? .5 : (busyId === lead.id ? .6 : 1),
                borderLeft: `3px solid ${takenByOther ? 'var(--border)' : overnight ? 'var(--warning)' : 'var(--danger)'}`,
                background: mine ? 'var(--accent-bg)' : 'transparent',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginBottom: 3 }}>
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .4, color: 'var(--accent)' }}>
                  {lead.provider || 'Lead'}
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{ago(lead.submitted_at)}</span>
              </div>

              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lead.name || 'Unknown'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{lead.phone || 'No phone'}</div>

              {lead.job_type && (
                <div style={{ fontSize: 10, color: 'var(--text-primary)', marginTop: 3, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {lead.job_type}
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                {lead.urgency && (
                  <span style={{ fontSize: 9, background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
                    {lead.urgency}
                  </span>
                )}
                {lead.lead_fee != null && (
                  <span style={{ fontSize: 9, background: 'var(--surface-2)', color: 'var(--text-muted)', borderRadius: 3, padding: '1px 5px' }}>
                    ${Number(lead.lead_fee).toFixed(2)}
                  </span>
                )}
                {overnight && (
                  <span style={{ fontSize: 9, background: 'var(--warning-bg, #fdf6e3)', color: 'var(--warning)', borderRadius: 3, padding: '1px 5px' }}>
                    overnight
                  </span>
                )}
              </div>

              {lead.claimed_by && (
                <div style={{ fontSize: 9, marginTop: 5, color: mine ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600 }}>
                  {mine ? 'You claimed this' : `${lead.claimed_by} is working this`}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
