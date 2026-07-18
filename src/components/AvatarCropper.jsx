// Drag-and-zoom cropper so a rep sees exactly what lands in the circle before
// saving. Outputs a 128px square JPEG data URI (Avatar clips it to a circle).
import { useState, useRef, useEffect } from 'react'

const V = 260    // on-screen viewport px
const OUT = 128  // exported px

export default function AvatarCropper({ src, onDone, onCancel }) {
  const [img, setImg] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef(null)

  useEffect(() => {
    const im = new Image()
    im.onload = () => {
      const cover = Math.max(V / im.width, V / im.height)
      setImg(im)
      setOffset({ x: (V - im.width * cover) / 2, y: (V - im.height * cover) / 2 })  // centered
    }
    im.src = src
  }, [src])

  const scale = img ? Math.max(V / img.width, V / img.height) * zoom : 1
  const dw = img ? img.width * scale : 0
  const dh = img ? img.height * scale : 0
  // Keep the image covering the viewport — no empty corners.
  const clamp = (o) => ({ x: Math.min(0, Math.max(V - dw, o.x)), y: Math.min(0, Math.max(V - dh, o.y)) })

  useEffect(() => { setOffset(o => clamp(o)) }, [zoom, img]) // eslint-disable-line react-hooks/exhaustive-deps

  const pt = (e) => { const t = e.touches?.[0] || e; return { x: t.clientX, y: t.clientY } }
  const onDown = (e) => { const p = pt(e); drag.current = { sx: p.x, sy: p.y, ox: offset.x, oy: offset.y } }
  const onMove = (e) => {
    if (!drag.current) return
    const p = pt(e)
    setOffset(clamp({ x: drag.current.ox + (p.x - drag.current.sx), y: drag.current.oy + (p.y - drag.current.sy) }))
  }
  const onUp = () => { drag.current = null }

  const confirm = () => {
    if (!img) return
    const k = OUT / V
    const c = document.createElement('canvas'); c.width = OUT; c.height = OUT
    c.getContext('2d').drawImage(img, offset.x * k, offset.y * k, dw * k, dh * k)
    onDone(c.toDataURL('image/jpeg', 0.85))
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:600, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'var(--surface)', borderRadius:12, padding:24, boxShadow:'0 8px 32px rgba(0,0,0,.3)', width:340 }}>
        <div style={{ fontSize:15, fontWeight:600, marginBottom:4 }}>Position your photo</div>
        <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:16 }}>Drag to move, slide to zoom. The circle is what shows.</div>
        <div onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
          onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}
          style={{ width:V, height:V, margin:'0 auto', position:'relative', overflow:'hidden', borderRadius:8, background:'#000', cursor:'grab', touchAction:'none', userSelect:'none' }}>
          {img && <img src={src} draggable="false" alt="" style={{ position:'absolute', left:offset.x, top:offset.y, width:dw, height:dh, maxWidth:'none' }} />}
          {/* Circular window: darkens everything outside the circle. */}
          <div style={{ position:'absolute', inset:0, borderRadius:'50%', boxShadow:'0 0 0 9999px rgba(0,0,0,.5)', pointerEvents:'none' }} />
        </div>
        <input type="range" min="1" max="3" step="0.01" value={zoom} onChange={e => setZoom(Number(e.target.value))}
          style={{ width:V, display:'block', margin:'16px auto 0' }} />
        <div className="modal-actions" style={{ marginTop:10 }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={confirm} disabled={!img}>Use photo</button>
        </div>
      </div>
    </div>
  )
}
