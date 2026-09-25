// Local US ringback (440 + 480 Hz, 2s on / 4s off) for outbound calls.
//
// The dial TwiML asks Twilio for a ringtone, which reaches the browser as
// early media. When a call rings with NO early media, the Voice SDK plays
// nothing — the rep sat in dead air until voicemail picked up (Deanna,
// Sep 24). This fills exactly that gap and stops the moment the call is
// answered, fails, or is hung up.
let ctx = null
let live = null   // { gain, oscs, timer }

export function startRingback() {
  if (live) return
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    ctx = ctx || new AC()
    ctx.resume?.().catch(() => {})
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(ctx.destination)
    const oscs = [440, 480].map(f => {
      const o = ctx.createOscillator()
      o.frequency.value = f
      o.connect(gain)
      o.start()
      return o
    })
    // Short ramps so each ring starts and stops without a click.
    const ring = () => {
      const t = ctx.currentTime
      gain.gain.cancelScheduledValues(t)
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.06, t + 0.03)
      gain.gain.setValueAtTime(0.06, t + 1.97)
      gain.gain.linearRampToValueAtTime(0, t + 2)
    }
    ring()
    live = { gain, oscs, timer: setInterval(ring, 6000) }
  } catch (e) {
    console.warn('ringback:', e.message)
  }
}

export function stopRingback() {
  if (!live) return
  const { gain, oscs, timer } = live
  live = null
  clearInterval(timer)
  try {
    oscs.forEach(o => o.stop())
    gain.disconnect()
  } catch {}
}
