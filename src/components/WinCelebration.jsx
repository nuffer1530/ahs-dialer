import { useEffect, useState, useRef } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'

function Particle({ style }) {
  return <div style={{ position:'fixed', borderRadius:3, ...style, animation:'fall 3s ease-in forwards', pointerEvents:'none' }} />
}

export default function WinCelebration() {
  const { profile } = useAuth()
  const [celebration, setCelebration] = useState(null)
  const [particles, setParticles] = useState([])
  const channelRef = useRef(null)
  const timeoutRef = useRef(null)

  // The card says "YOU earned" — so it must only fire for the rep the payout
  // belongs to. A ref keeps the check current without resubscribing.
  const myIdRef = useRef(null)
  useEffect(() => { myIdRef.current = profile?.id || null }, [profile?.id])

  // Where the celebration marker lives. Realtime only reaches a tab that's
  // awake with a live socket at the exact insert moment — the commission sync
  // usually pays while the rep is mid-call or away, so most wins were never
  // shown. This marker + the catch-up below guarantee the pop on their next
  // app load instead.
  const seenKey = (pid) => `andi_pay_seen:${pid}`
  const markSeen = (pid, ts) => { try { localStorage.setItem(seenKey(pid), ts || new Date().toISOString()) } catch {} }

  // Catch-up: anything earned since the last shown payout pops now, whatever
  // page they're on. Looks back 3 days max so a long vacation doesn't replay
  // ancient history.
  useEffect(() => {
    const pid = profile?.id
    if (!pid) return
    ;(async () => {
      let since = null
      try { since = localStorage.getItem(seenKey(pid)) } catch {}
      if (!since) { markSeen(pid); return }   // first run: baseline, no replay
      const floor = new Date(Date.now() - 3 * 864e5).toISOString()
      const { data } = await sb.from('commissions').select('*')
        .eq('profile_id', pid).gt('amount', 0)
        .gt('synced_at', since > floor ? since : floor)
        .order('synced_at', { ascending: true })
      if (!data?.length) return
      const latest = data[data.length - 1]
      markSeen(pid, latest.synced_at)
      triggerCelebration({
        repName: latest.rep_name, contactName: latest.contact_name,
        amount: Number(latest.amount || 0), eventType: latest.event_type,
        alsoMembership: latest.also_membership, membershipAmount: latest.membership_amount,
        extraCount: data.length - 1,
      })
    })()
  }, [profile?.id])

  useEffect(() => {
    channelRef.current = sb.channel('win-celebrations')
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'commissions' }, payload => {
        const { profile_id, amount, event_type, contact_name, rep_name, also_membership, membership_amount, synced_at } = payload.new
        if (!profile_id || profile_id !== myIdRef.current) return   // someone else's win
        if (!(Number(amount) > 0)) return                            // reversals don't confetti
        markSeen(profile_id, synced_at)
        triggerCelebration({ repName: rep_name, contactName: contact_name, amount, eventType: event_type, alsoMembership: also_membership, membershipAmount: membership_amount })
      })
      .subscribe()
    return () => { if (channelRef.current) sb.removeChannel(channelRef.current) }
  }, [])

  const triggerCelebration = ({ repName, contactName, amount, eventType, alsoMembership, membershipAmount }) => {
    const colors = ['#ff751f','#16A34A','#FFC107','#E91E63','#9C27B0','#3b82f6','#00BCD4']
    const newParticles = Array.from({ length:80 }, (_, i) => ({
      id: i, left:`${Math.random()*100}%`, top:`-${Math.random()*20+10}px`,
      width:`${Math.random()*10+6}px`, height:`${Math.random()*10+6}px`,
      background: colors[Math.floor(Math.random()*colors.length)],
      animationDelay:`${Math.random()*1.5}s`, animationDuration:`${Math.random()*1.5+2}s`,
      transform:`rotate(${Math.random()*360}deg)`,
    }))
    setParticles(newParticles)
    setCelebration({ repName, contactName, amount, eventType, alsoMembership, membershipAmount })
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => { setCelebration(null); setParticles([]) }, 6000)
  }

  if (!celebration) return null

  const totalEarned = (celebration.amount || 0) + (celebration.alsoMembership ? (celebration.membershipAmount || 0) : 0)

  return (
    <>
      <style>{`
        @keyframes fall { 0%{transform:translateY(0) rotate(0deg);opacity:1} 100%{transform:translateY(100vh) rotate(720deg);opacity:0} }
        @keyframes popIn { 0%{transform:translate(-50%,-50%) scale(0.5);opacity:0} 70%{transform:translate(-50%,-50%) scale(1.05);opacity:1} 100%{transform:translate(-50%,-50%) scale(1);opacity:1} }
        @keyframes coinSpin { 0%{transform:rotateY(0deg)} 100%{transform:rotateY(360deg)} }
      `}</style>

      {particles.map(p => (
        <Particle key={p.id} style={{ left:p.left, top:p.top, width:p.width, height:p.height, background:p.background, animationDelay:p.animationDelay, animationDuration:p.animationDuration, zIndex:9999 }} />
      ))}

      <div style={{ position:'fixed', top:'50%', left:'50%', zIndex:10000, animation:'popIn 0.5s cubic-bezier(0.175,0.885,0.32,1.275) forwards', background:'#fff', borderRadius:24, padding:'36px 48px', boxShadow:'0 24px 64px rgba(0,0,0,.35)', textAlign:'center', border:'3px solid #16A34A', minWidth:360 }}>
        <div style={{ fontSize:64, marginBottom:4, lineHeight:1 }}>🎉</div>
        <div style={{ fontSize:30, fontWeight:800, color:'#16A34A', marginBottom:6, letterSpacing:-.5 }}>BOOKED!</div>
        <div style={{ fontSize:17, fontWeight:600, color:'#1C1B19', marginBottom:2 }}>{celebration.contactName}</div>
        <div style={{ fontSize:13, color:'#6B6760', marginBottom:20 }}>
          {celebration.repName} just closed one! 🔥
          {celebration.extraCount > 0 && <span> (+{celebration.extraCount} more payout{celebration.extraCount === 1 ? '' : 's'} while you were away — see My Page)</span>}
        </div>

        {/* Commission earned */}
        <div style={{ background:'linear-gradient(135deg, #16A34A, #15803D)', borderRadius:16, padding:'16px 24px', marginBottom:20 }}>
          <div style={{ fontSize:12, color:'rgba(255,255,255,.8)', fontWeight:600, textTransform:'uppercase', letterSpacing:.8, marginBottom:6 }}>You earned</div>
          <div style={{ fontSize:42, fontWeight:900, color:'#fff', letterSpacing:-1, lineHeight:1 }}>
            ${totalEarned.toFixed(2)}
          </div>
          {celebration.alsoMembership && (
            <div style={{ display:'flex', gap:12, justifyContent:'center', marginTop:8 }}>
              <span style={{ fontSize:11, color:'rgba(255,255,255,.85)', background:'rgba(255,255,255,.15)', padding:'2px 10px', borderRadius:99 }}>📋 Booking: ${(celebration.amount||0).toFixed(2)}</span>
              <span style={{ fontSize:11, color:'rgba(255,255,255,.85)', background:'rgba(255,255,255,.15)', padding:'2px 10px', borderRadius:99 }}>⭐ Membership: ${(celebration.membershipAmount||0).toFixed(2)}</span>
            </div>
          )}
        </div>

        <button onClick={() => { setCelebration(null); setParticles([]) }}
          style={{ padding:'10px 32px', background:'#16A34A', color:'#fff', border:'none', borderRadius:10, cursor:'pointer', fontSize:14, fontWeight:700 }}>
          Let's go! 💪
        </button>
      </div>

      <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:9998 }} onClick={() => { setCelebration(null); setParticles([]) }} />
    </>
  )
}
