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
      // Hand back the whole contact, not just its id. It was created server-side
      // a millisecond ago, so the realtime INSERT hasn't reached the browser's
      // cache yet — navigating by id alone opens an empty tab.
      onOpenContact?.(pd.contact || (pd.contactId ? { id: pd.contactId } : null))
    } catch (e) {
      setErr(e.message)
    } finally { setBusyId(null) }
  }

  return (
    <>
      <div style={{ padding: '14px 14px 10px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="disp" style={{ fontSize: 16, fontWeight: 700 }}>Paid leads</span>
          {leads.length > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, background: 'var(--signal)', color: '#0D1013', borderRadius: 99, padding: '1px 8px' }}>
              {leads.length}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
          Work these first — first to open claims it
        </div>
      </div>

      {err && (
        <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: 11.5, padding: '8px 14px', margin: '0 8px 8px', borderRadius: 10 }}>
          {err}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {leads.length === 0 && (
          <div style={{ padding: '22px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>
            No open leads.<br />
            <span style={{ fontSize: 11.5 }}>New ones appear here within a minute.</span>
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
                padding: '11px 12px', borderRadius: 12,
                border: `1px solid ${mine ? 'var(--accent)' : 'var(--border)'}`,
                cursor: takenByOther ? 'not-allowed' : 'pointer',
                opacity: takenByOther ? .5 : (busyId === lead.id ? .6 : 1),
                background: mine ? 'var(--accent-bg)' : 'var(--surface)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 4 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, flexShrink: 0, background: takenByOther ? 'var(--border-strong)' : overnight ? 'var(--warning)' : 'var(--signal)' }} />
                  {lead.provider || 'Lead'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ago(lead.submitted_at)}</span>
              </div>

              <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lead.name || 'Unknown'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>{lead.phone || 'No phone'}</div>

              {lead.job_type && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {lead.job_type}
                </div>
              )}

              {/* Some partners (Scorpion) book the job through a path that never
                  converts the booking, so it still reads "New" while a tech is
                  actually scheduled. Badged rather than hidden — the rep should
                  see it came through, and confirm rather than re-book. */}
              {lead.already_booked && (
                <div style={{ marginTop: 6, padding: '6px 9px', borderRadius: 8, background: 'var(--tone-green-bg)', border: '1px solid var(--tone-green-bd)', fontSize: 11, color: 'var(--tone-green-tx)', fontWeight: 700, lineHeight: 1.4 }}>
                  ALREADY SCHEDULED{lead.booked_job_number ? ` · Job #${lead.booked_job_number}` : ''}
                  {lead.booked_at && (
                    <div style={{ fontWeight: 500, marginTop: 1 }}>
                      {new Date(lead.booked_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  )}
                  <div style={{ fontWeight: 500, marginTop: 1 }}>Confirm — don't re-book</div>
                </div>
              )}

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
                {lead.urgency && (
                  <span style={{ fontSize: 10.5, background: 'var(--tone-red-bg)', color: 'var(--tone-red-tx)', borderRadius: 99, padding: '1px 8px', fontWeight: 700 }}>
                    {lead.urgency}
                  </span>
                )}
                {lead.lead_fee != null && (
                  <span style={{ fontSize: 10.5, background: 'var(--surface-2)', color: 'var(--text-secondary)', borderRadius: 99, padding: '1px 8px', fontFamily: 'var(--font-mono)' }}>
                    ${Number(lead.lead_fee).toFixed(2)}
                  </span>
                )}
                {overnight && (
                  <span style={{ fontSize: 10.5, background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', borderRadius: 99, padding: '1px 8px', fontWeight: 600 }}>
                    overnight
                  </span>
                )}
              </div>

              {lead.claimed_by && (
                <div style={{ fontSize: 11.5, marginTop: 6, color: mine ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600 }}>
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
