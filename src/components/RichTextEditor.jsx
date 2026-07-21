import { useRef, useEffect } from 'react'

// Minimal rich text: Bold / Italic / Underline / text color. contentEditable +
// execCommand — deprecated on paper, universally supported in practice, and it
// keeps us dependency-free (no npm available in this environment to add an
// editor library anyway). Value is an HTML string; legacy plain-text scripts
// are converted (newlines → <br>) on first edit.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const toEditableHtml = (v) => {
  const s = String(v || '')
  return /<[a-z][^>]*>/i.test(s) ? s : esc(s).replace(/\n/g, '<br>')
}

// Strip anything that could execute; keep formatting tags and color styles.
export const sanitizeRich = (html) => String(html || '')
  .replace(/<(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
  .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '')

// Render stored script/tips: HTML gets sanitized markup, legacy plain text
// keeps its line breaks.
export function RichText({ html, style }) {
  const s = String(html || '')
  if (!/<[a-z][^>]*>/i.test(s)) return <div style={{ whiteSpace: 'pre-wrap', ...style }}>{s}</div>
  return <div style={style} dangerouslySetInnerHTML={{ __html: sanitizeRich(s) }} />
}

const COLORS = [
  { c: '#DC2626', label: 'Red' },
  { c: '#EA580C', label: 'Orange' },
  { c: '#16A34A', label: 'Green' },
  { c: '#2563EB', label: 'Blue' },
  { c: '#7C3AED', label: 'Purple' },
]

export default function RichTextEditor({ value, onChange, placeholder, minHeight = 120 }) {
  const ref = useRef(null)
  const focusedRef = useRef(false)

  // Sync external value in, but never stomp the DOM mid-typing.
  useEffect(() => {
    const el = ref.current
    if (!el || focusedRef.current) return
    const next = toEditableHtml(value)
    if (el.innerHTML !== next) el.innerHTML = next
  }, [value])

  const emit = () => onChange(ref.current ? ref.current.innerHTML : '')
  const cmd = (name, arg) => {
    ref.current?.focus()
    try { document.execCommand('styleWithCSS', false, true) } catch {}
    document.execCommand(name, false, arg)
    emit()
  }

  const btn = {
    width: 26, height: 24, border: '1px solid var(--border)', borderRadius: 5,
    background: 'var(--surface)', color: 'var(--text-primary)', cursor: 'pointer',
    fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 8px', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)', flexWrap: 'wrap' }}
        onMouseDown={e => e.preventDefault() /* keep the text selection alive */}>
        <button type="button" style={{ ...btn, fontWeight: 800 }} title="Bold" onClick={() => cmd('bold')}>B</button>
        <button type="button" style={{ ...btn, fontStyle: 'italic', fontFamily: 'serif' }} title="Italic" onClick={() => cmd('italic')}>I</button>
        <button type="button" style={{ ...btn, textDecoration: 'underline' }} title="Underline" onClick={() => cmd('underline')}>U</button>
        <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 3px' }} />
        {COLORS.map(({ c, label }) => (
          <button key={c} type="button" title={label} onClick={() => cmd('foreColor', c)}
            style={{ ...btn, width: 20 }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: c, display: 'inline-block' }} />
          </button>
        ))}
        <button type="button" title="Default color" onClick={() => cmd('foreColor', 'inherit')}
          style={{ ...btn, width: 'auto', padding: '0 7px', fontSize: 10, color: 'var(--text-muted)' }}>reset</button>
      </div>
      <div ref={ref} contentEditable suppressContentEditableWarning
        onFocus={() => { focusedRef.current = true }}
        onBlur={() => { focusedRef.current = false; emit() }}
        onInput={emit}
        data-placeholder={placeholder || ''}
        style={{ minHeight, padding: '10px 12px', fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-primary)', outline: 'none', wordBreak: 'break-word' }} />
    </div>
  )
}
