useEffect(() => {
  channelRef.current = sb.channel('win-celebrations')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_logs' }, payload => {
      if (payload.new.outcome !== 'Booked') return
      const rep = payload.new.rep || 'Someone'
      const contactId = payload.new.contact_id
      // Use setTimeout to avoid blocking the channel callback
      setTimeout(() => {
        sb.from('contacts').select('name').eq('id', contactId).single()
          .then(({ data }) => triggerCelebration(rep, data?.name || 'a contact'))
      }, 0)
    })
    .subscribe()
  return () => { if (channelRef.current) sb.removeChannel(channelRef.current) }
}, [])

  const triggerCelebration = (rep, contactName) => {
    // Generate confetti particles
    const colors = ['#1A5C8A','#2E7D52','#FFC107','#E91E63','#9C27B0','#FF5722','#00BCD4']
    const newParticles = Array.from({ length: 80 }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      top: `-${Math.random() * 20 + 10}px`,
      width: `${Math.random() * 10 + 6}px`,
      height: `${Math.random() * 10 + 6}px`,
      background: colors[Math.floor(Math.random() * colors.length)],
      animationDelay: `${Math.random() * 1.5}s`,
      animationDuration: `${Math.random() * 1.5 + 2}s`,
      transform: `rotate(${Math.random() * 360}deg)`,
    }))
    setParticles(newParticles)
    setCelebration({ rep, contactName })
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setCelebration(null)
      setParticles([])
    }, 5000)
  }

  if (!celebration) return null

  return (
    <>
      <style>{`
        @keyframes fall {
          0% { transform: translateY(0) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
        @keyframes popIn {
          0% { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
          70% { transform: translate(-50%, -50%) scale(1.05); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        }
        @keyframes fadeOut {
          0% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>

      {/* Confetti */}
      {particles.map(p => (
        <Particle key={p.id} style={{
          left: p.left, top: p.top, width: p.width, height: p.height,
          background: p.background, animationDelay: p.animationDelay,
          animationDuration: p.animationDuration, zIndex: 9999,
        }} />
      ))}

      {/* Celebration card */}
      <div style={{
        position: 'fixed', top: '50%', left: '50%', zIndex: 10000,
        animation: 'popIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards',
        background: 'white', borderRadius: 20, padding: '40px 48px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.3)', textAlign: 'center',
        border: '3px solid #2E7D52', minWidth: 340,
      }}>
        <div style={{ fontSize: 64, marginBottom: 8, lineHeight: 1 }}>🎉</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: '#2E7D52', marginBottom: 6 }}>BOOKED!</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#1C1B19', marginBottom: 4 }}>{celebration.contactName}</div>
        <div style={{ fontSize: 14, color: '#6B6760' }}>{celebration.rep} just closed one! 🔥</div>
        <button onClick={() => { setCelebration(null); setParticles([]) }}
          style={{ marginTop: 20, padding: '8px 24px', background: '#2E7D52', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          Let's go! 💪
        </button>
      </div>

      {/* Overlay */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9998 }} onClick={() => { setCelebration(null); setParticles([]) }} />
    </>
  )
}
