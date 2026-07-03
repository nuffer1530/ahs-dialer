import { useEffect } from 'react'

export default function Modal({ title, onClose, children, width = 460 }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: width }}>
        {title && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:18 }}>
            <h2 className="modal-title" style={{ margin:0 }}>{title}</h2>
            <button className="btn ghost sm" onClick={onClose} style={{ fontSize:16, padding:'2px 8px' }}>✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  )
}
