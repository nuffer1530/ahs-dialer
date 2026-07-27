import { useState, useRef, useEffect } from 'react'
import { sb } from '../lib/supabase'

// 💡 Ask Andi — floating knowledge assistant, bottom-right on every page.
// Answers come from the admin-managed knowledge base (Settings → Knowledge)
// plus the inbound scripts; company facts are never invented, and every
// answer cites the articles it used.

// Markdown-lite renderer: **bold**, - bullets, numbered steps, paragraph
// spacing. The raw text dump read as one jumbled block on a live call.
function inline(text) {
  return String(text).split(/\*\*([^*]+)\*\*/g).map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p))
}
function AnswerText({ text }) {
  const blocks = []
  let list = null
  const flush = () => { if (list) { blocks.push(list); list = null } }
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd()
    const bullet = line.match(/^\s*[-•]\s+(.*)/)
    const num = line.match(/^\s*\d+[.)]\s+(.*)/)
    if (bullet) { if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] } } list.items.push(bullet[1]) }
    else if (num) { if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] } } list.items.push(num[1]) }
    else if (!line.trim()) { flush(); blocks.push({ type: 'gap' }) }
    else { flush(); blocks.push({ type: 'p', text: line }) }
  }
  flush()
  return (
    <div>
      {blocks.map((b, i) => b.type === 'gap' ? <div key={i} style={{ height: 7 }} />
        : b.type === 'p' ? <div key={i} style={{ marginBottom: 2 }}>{inline(b.text)}</div>
        : b.type === 'ul' ? <ul key={i} style={{ margin: '3px 0', paddingLeft: 17 }}>{b.items.map((t, j) => <li key={j} style={{ marginBottom: 3 }}>{inline(t)}</li>)}</ul>
        : <ol key={i} style={{ margin: '3px 0', paddingLeft: 19 }}>{b.items.map((t, j) => <li key={j} style={{ marginBottom: 3 }}>{inline(t)}</li>)}</ol>)}
    </div>
  )
}

export default function AskAndi() {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState([])   // { role, content, sources?, covered?, logId?, fb? }
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef(null)

  // Scroll the START of the newest message into view — snapping to the very
  // bottom made every long answer/coach play open at its end, forcing the rep
  // to scroll up before reading.
  useEffect(() => {
    const el = bodyRef.current
    const last = el?.lastElementChild
    if (!el || !last) return
    el.scrollTop = Math.max(0, last.offsetTop - 10)
  }, [msgs, open, busy])

  // 🎧 Live coach: the dialer heard an objection on the call — open with the
  // play, silently (the rep is mid-conversation; no chime, no focus steal).
  useEffect(() => {
    const onCoach = (ev) => {
      const tip = ev.detail || {}
      setMsgs(prev => [...prev, {
        role: 'assistant', coach: true, coachLabel: tip.label, heard: tip.heard,
        content: tip.text, sources: tip.articleTitle ? [tip.articleTitle] : [],
      }])
      setOpen(true)
    }
    window.addEventListener('andi-coach', onCoach)
    return () => window.removeEventListener('andi-coach', onCoach)
  }, [])

  const ask = async () => {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setMsgs(prev => [...prev, { role: 'user', content: q }])
    setBusy(true)
    try {
      const { data: { session } } = await sb.auth.getSession()
      const history = msgs.slice(-8).map(m => ({ role: m.role, content: m.content }))
      const r = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ question: q, history }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Something went wrong')
      setMsgs(prev => [...prev, { role: 'assistant', content: d.answer, sources: d.sources, covered: d.covered, usedCraft: d.usedCraft, logId: d.logId }])
    } catch (e) {
      setMsgs(prev => [...prev, { role: 'assistant', content: `⚠️ ${e.message}`, sources: [] }])
    }
    setBusy(false)
  }

  const feedback = async (i, helpful) => {
    const m = msgs[i]
    if (m?.logId == null) return
    setMsgs(prev => prev.map((x, xi) => (xi === i ? { ...x, fb: helpful } : x)))
    try {
      const { data: { session } } = await sb.auth.getSession()
      await fetch('/api/assistant/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ logId: m.logId, helpful }),
      })
    } catch {}
  }

  return (
    <>
      {/* The floating button */}
      {!open && (
        <button onClick={() => setOpen(true)} title="Ask Andi — policies, objections, how-tos"
          style={{ position: 'fixed', bottom: 22, right: 22, zIndex: 1500, width: 52, height: 52, borderRadius: '50%',
            border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 23, cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(0,0,0,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          💡
        </button>
      )}

      {open && (
        <div style={{ position: 'fixed', bottom: 22, right: 22, zIndex: 1500, width: 390, maxWidth: 'calc(100vw - 44px)',
          height: 540, maxHeight: 'calc(100vh - 100px)', background: 'var(--surface)', borderRadius: 16,
          border: '1px solid var(--border)', boxShadow: '0 16px 48px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          <div style={{ padding: '12px 16px', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
            <span style={{ fontSize: 17 }}>💡</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800 }}>Ask Andi</div>
              <div style={{ fontSize: 10.5, opacity: .85 }}>Policies · objections · how-tos — answers cite their source</div>
            </div>
            <button onClick={() => setOpen(false)}
              style={{ border: 'none', background: 'rgba(255,255,255,.18)', color: '#fff', width: 26, height: 26, borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>×</button>
          </div>

          <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}>
            {msgs.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, padding: '6px 2px' }}>
                Try:
                {['What do I say when they want to think about it?',
                  'How do I explain the dispatch fee?',
                  'Customer says they already have a company they use'].map(q => (
                  <div key={q} onClick={() => setInput(q)}
                    style={{ marginTop: 6, padding: '7px 11px', border: '1px solid var(--border)', borderRadius: 10, cursor: 'pointer', background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
                    {q}
                  </div>
                ))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', width: m.coach ? '100%' : undefined }}>
                {m.coach && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: .5,
                      padding: '2px 9px', borderRadius: 99, background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', border: '1px solid var(--tone-amber-bd)' }}>
                      🎧 Live coach — {m.coachLabel}
                    </span>
                  </div>
                )}
                {m.coach && m.heard && (
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 3 }}>
                    Customer: "{m.heard}"
                  </div>
                )}
                <div style={{ padding: '9px 12px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.55,
                  whiteSpace: m.role === 'user' ? 'pre-wrap' : 'normal',
                  background: m.role === 'user' ? 'var(--accent)' : 'var(--surface-2)',
                  color: m.role === 'user' ? '#fff' : 'var(--text-primary)',
                  border: m.role === 'user' ? 'none' : m.coach ? '1px solid var(--tone-amber-bd)' : '1px solid var(--border)',
                  boxShadow: m.coach ? '0 0 0 2px var(--tone-amber-bg)' : 'none' }}>
                  {m.role === 'user' ? m.content : <AnswerText text={m.content} />}
                </div>
                {m.role === 'assistant' && (m.sources?.length > 0 || m.logId != null) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4, flexWrap: 'wrap' }}>
                    {(m.sources || []).map(t => (
                      <span key={t} style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 8px', borderRadius: 99,
                        background: 'var(--accent-bg)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
                        📄 {t}
                      </span>
                    ))}
                    {m.usedCraft && (
                      <span title="Blends your playbook with general sales expertise"
                        style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 8px', borderRadius: 99,
                        background: 'var(--tone-purple-bg)', color: 'var(--tone-purple-tx)', border: '1px solid var(--tone-purple-bd)' }}>
                        🧠 sales craft
                      </span>
                    )}
                    {m.covered === false && (
                      <span title="A company fact needed here isn't in the knowledge base yet"
                        style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 8px', borderRadius: 99,
                        background: 'var(--tone-amber-bg)', color: 'var(--tone-amber-tx)', border: '1px solid var(--tone-amber-bd)' }}>
                        fact not in KB
                      </span>
                    )}
                    {m.logId != null && (
                      <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
                        {[[true, '👍'], [false, '👎']].map(([v, em]) => (
                          <button key={em} onClick={() => feedback(i, v)} disabled={m.fb != null}
                            style={{ border: 'none', background: 'none', cursor: m.fb == null ? 'pointer' : 'default',
                              fontSize: 12, opacity: m.fb == null ? .55 : m.fb === v ? 1 : .2 }}>
                            {em}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>💭 Checking the knowledge base…</div>}
          </div>

          <div style={{ padding: 10, borderTop: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
            <input className="form-input" autoFocus value={input} placeholder="Ask anything…"
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') ask() }}
              style={{ flex: 1 }} />
            <button className="btn primary" onClick={ask} disabled={busy || !input.trim()} style={{ flexShrink: 0 }}>
              {busy ? '…' : 'Ask'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
