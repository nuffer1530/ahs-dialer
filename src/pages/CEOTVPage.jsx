import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { fmtTime, fmtDate } from '../lib/denver'

// CEO board (/tv/ceo) — Brandyn's office TV. Single dense 16:9 screen:
// money row, ops row, Path-of-the-Year chart + leads, dept-TV-style top-5
// tables, live feed. Data: /api/tv/department/company (tiles/techs/feed),
// /api/tv/csr-month (CSRs), /api/tv/ceo (pacing/GM/today extras).
const C = {
  bg:'#0B0F14', panel:'#141A21', border:'#252E38',
  text:'#E6EDF3', muted:'#8B949E', dim:'#6E7681',
  green:'#3FB950', blue:'#58A6FF', amber:'#D29922', red:'#F85149', purple:'#BC8CFF', orange:'#FF751F',
}
const TRADE_SHORT = { 'HVAC':'HVAC', 'Plumbing':'PLB', 'Electrical':'ELE', 'Garage Doors':'GAR' }
const fmtK = (n) => n == null ? '—' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : '$' + Math.round(n / 1000) + 'k'
const fmtMoney = (n) => n == null ? '—' : '$' + Math.round(n).toLocaleString()
const fmtN = (n) => n == null ? '—' : Number(n).toLocaleString()
const MEDALS = ['#F0B429', '#B8BEC7', '#CD7F32']

function Rank({ i }) {
  const m = MEDALS[i]
  if (!m) return <span style={{ color:C.dim, fontWeight:800 }}>{i + 1}</span>
  return <span style={{ display:'inline-flex', alignItems:'center', justifyContent:'center', width:22, height:22, borderRadius:'50%', background:`${m}1F`, border:`1.5px solid ${m}`, color:m, fontWeight:800, fontSize:12 }}>{i + 1}</span>
}

function Card({ children, style }) {
  return <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:12, padding:'10px 14px', minWidth:0, minHeight:0, overflow:'hidden', display:'flex', flexDirection:'column', ...style }}>{children}</div>
}
function Lbl({ children }) {
  return <div style={{ fontSize:11, letterSpacing:1, textTransform:'uppercase', color:C.muted, fontWeight:700, marginBottom:4, whiteSpace:'nowrap' }}>{children}</div>
}
function Trio({ items }) {
  return (
    <div style={{ display:'flex', gap:14, marginTop:'auto' }}>
      {items.map(([v, k, col]) => (
        <div key={k} style={{ minWidth:0 }}>
          <div style={{ fontSize:'clamp(14px,1.3vw,22px)', fontWeight:700, color:col || C.text, whiteSpace:'nowrap' }}>{v}</div>
          <div style={{ fontSize:10, color:C.muted, textTransform:'uppercase', letterSpacing:.5 }}>{k}</div>
        </div>
      ))}
    </div>
  )
}
function Big({ children, color }) {
  return <div style={{ fontSize:'clamp(22px,2.4vw,40px)', fontWeight:800, lineHeight:1.05, color: color || C.text, whiteSpace:'nowrap' }}>{children}</div>
}

// The Path of the Year: monthly bars (actual → projected) + prior-year dots.
function YearChart({ slow }) {
  if (!slow?.months) return <div style={{ color:C.dim, fontSize:13 }}>Building the year… first load takes a few minutes.</div>
  const now = new Date()
  const curY = now.getFullYear(), curM = now.getMonth() + 1
  const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0)
  const bars = []
  for (let m = 1; m <= 12; m++) {
    const actual = m < curM ? sum(slow.months[ym(curY, m)]) : m === curM ? sum(slow.mtd) : 0
    const proj = m >= curM ? (slow.projMonths?.[ym(curY, m)] || 0) : 0
    bars.push({ m, actual, proj, prior: sum(slow.months[ym(curY - 1, m)]) })
  }
  const mx = Math.max(...bars.map(b => Math.max(b.actual, b.proj, b.prior)), 1) * 1.22
  const W = 1000, H = 235, BW = 54, GAP = (W - 60 - 12 * BW) / 11
  const x = (i) => 40 + i * (BW + GAP)
  const y = (v) => 200 - (v / mx) * 170
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:'100%' }} preserveAspectRatio="xMidYMid meet">
      <line x1="30" y1="200" x2={W - 5} y2="200" stroke={C.border} />
      {bars.map((b, i) => (
        <g key={b.m}>
          {b.m < curM && b.actual > 0 && <>
            <rect x={x(i)} y={y(b.actual)} width={BW} height={200 - y(b.actual)} fill={C.green} rx="3" />
            <text x={x(i) + BW / 2} y={y(b.actual) - 6} fontSize="12" fill={C.text} textAnchor="middle" fontWeight="700">{Math.round(b.actual / 1000)}</text>
          </>}
          {b.m === curM && <>
            {b.actual > 0 && <rect x={x(i)} y={y(b.actual)} width={BW} height={200 - y(b.actual)} fill={C.green} rx="3" />}
            {b.proj > b.actual && <rect x={x(i)} y={y(b.proj)} width={BW} height={y(b.actual) - y(b.proj)} fill={`${C.green}44`} stroke={C.green} strokeDasharray="4 3" rx="3" />}
            <text x={x(i) + BW / 2} y={y(Math.max(b.proj, b.actual)) - 6} fontSize="12" fill="#7EE2A8" textAnchor="middle" fontWeight="700">→{Math.round(Math.max(b.proj, b.actual) / 1000)}</text>
          </>}
          {b.m > curM && b.proj > 0 && <>
            <rect x={x(i)} y={y(b.proj)} width={BW} height={200 - y(b.proj)} fill="#1B2734" stroke={C.blue} strokeDasharray="4 3" rx="3" />
            <text x={x(i) + BW / 2} y={y(b.proj) - 6} fontSize="12" fill="#8FC1FF" textAnchor="middle" fontWeight="700">{Math.round(b.proj / 1000)}</text>
          </>}
          {b.prior > 0 && <circle cx={x(i) + BW / 2} cy={y(b.prior)} r="4" fill={C.dim} />}
          <text x={x(i) + BW / 2} y="218" fontSize="11" fill={C.muted} textAnchor="middle">{names[b.m - 1]}</text>
        </g>
      ))}
      <g>
        <rect x={W - 250} y="8" width="245" height="42" rx="9" fill={C.panel} stroke={C.blue} />
        <text x={W - 127} y="26" fontSize="14" fill="#8FC1FF" textAnchor="middle" fontWeight="800">
          YEAR LANDS: {fmtK(slow.pacing?.yearProj)} ({slow.pacing?.yoy >= 0 ? '+' : ''}{slow.pacing?.yoy}%)
        </text>
        <text x={W - 127} y="42" fontSize="10.5" fill={C.muted} textAnchor="middle">green = booked · dashed = projection · dots = last year</text>
      </g>
    </svg>
  )
}

export default function CEOTVPage() {
  const [co, setCo] = useState(null)      // /api/tv/department/company
  const [csr, setCsr] = useState(null)    // /api/tv/csr-month
  const [ceo, setCeo] = useState(null)    // /api/tv/ceo
  const [err, setErr] = useState(null)
  const [time, setTime] = useState(new Date())

  const load = useCallback(async () => {
    try {
      const { data: { session } } = await sb.auth.getSession()
      if (!session) return
      const h = { headers: { Authorization: `Bearer ${session.access_token}` } }
      const [r1, r3] = await Promise.all([fetch('/api/tv/department/company', h), fetch('/api/tv/ceo', h)])
      if (r1.ok) setCo(await r1.json())
      if (r3.ok) setCeo(await r3.json()); else if (r3.status === 403) setErr('This board is leadership-only — log the TV in with an allowed account.')
    } catch (e) { console.warn('ceo tv:', e.message) }
  }, [])
  const loadCsr = useCallback(async () => {
    try {
      const { data: { session } } = await sb.auth.getSession()
      if (!session) return
      const r = await fetch('/api/tv/csr-month', { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (r.ok) setCsr(await r.json())
    } catch (e) { console.warn('ceo tv csr:', e.message) }
  }, [])

  useEffect(() => {
    load(); loadCsr()
    const t1 = setInterval(load, 60_000)
    const t2 = setInterval(loadCsr, 5 * 60_000)
    const t3 = setInterval(() => setTime(new Date()), 30_000)
    return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3) }
  }, [load, loadCsr])

  const day = co?.daily, mon = co?.monthly, yr = co?.yearly
  const fast = ceo?.fast, slow = ceo?.slow
  const techs = (co?.techs || []).slice(0, 5)
  const csrs = (() => {
    const list = (csr?.csrs || []).map(r => ({ ...r, rate: r.leadCalls > 0 ? r.booked / r.leadCalls : 0 }))
    const mb = Math.max(1, ...list.map(r => r.booked)), mr = Math.max(0.01, ...list.map(r => r.rate)), mq = Math.max(1, ...list.map(r => r.qa || 0))
    for (const r of list) r.score = Math.round(100 * (0.5 * r.booked / mb + 0.3 * r.rate / mr + 0.2 * (r.qa || 0) / mq))
    return list.sort((a, b) => b.score - a.score).slice(0, 5)
  })()
  const feed = (co?.feed || []).slice(0, 7)
  const gm = slow?.gm
  const oppPct = fast?.opps ? Math.min(100, Math.round(fast.opps.total / (fast.opps.goal || 33) * 100)) : 0

  const th = (t, right = true) => <td style={{ padding:'2px 6px', fontSize:10, color:C.dim, textTransform:'uppercase', letterSpacing:.5, textAlign: right ? 'right' : 'left' }}>{t}</td>
  const cell = (v, fmt = fmtN, col, best) => <td style={{ padding:'2px 6px', textAlign:'right', fontWeight: best ? 800 : 600, color: col || C.text, fontSize:'clamp(11px,1vw,15px)', whiteSpace:'nowrap' }}>{fmt(v)}</td>

  const gmCol = (v) => v == null ? C.dim : v >= 50 ? C.green : v >= 42 ? C.amber : C.red

  if (err) return <div style={{ height:'100vh', background:C.bg, color:C.red, display:'flex', alignItems:'center', justifyContent:'center', fontSize:20 }}>{err}</div>

  return (
    <div style={{ height:'100vh', width:'100vw', background:C.bg, color:C.text, padding:'10px 14px', display:'grid', boxSizing:'border-box', overflow:'hidden',
      gridTemplateColumns:'repeat(12, 1fr)', gridTemplateRows:'42px 15% 14% 26% 1fr', gap:10,
      fontFamily:'-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif' }}>

      <div style={{ gridColumn:'1/13', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ fontSize:'clamp(16px,1.7vw,26px)', fontWeight:800, letterSpacing:.5 }}>
          <span style={{ color:C.orange }}>🏠 AWESOME HOME SERVICES</span> — CEO BOARD
        </div>
        <div style={{ color:C.muted, fontSize:'clamp(11px,1vw,15px)' }}>
          {fmtDate(time, { weekday:'long', month:'long', day:'numeric' })} · {fmtTime(time)} · updated {co ? fmtTime(co.updatedAt) : '…'}
        </div>
      </div>

      {/* Row 1 — money */}
      <Card style={{ gridColumn:'1/4' }}>
        <Lbl>Sales (sold estimates)</Lbl>
        <Big color={C.green}>{fmtMoney(day?.sales)}</Big>
        <Trio items={[[fmtK(mon?.sales), 'MTD'], [fmtK(yr?.sales), 'YTD']]} />
      </Card>
      <Card style={{ gridColumn:'4/7' }}>
        <Lbl>Revenue (invoiced)</Lbl>
        <Big>{fmtMoney(day?.revenue)}</Big>
        <Trio items={[[fmtK(mon?.revenue), 'MTD'], [fmtK(yr?.revenue), 'YTD']]} />
      </Card>
      <Card style={{ gridColumn:'7/10' }}>
        <Lbl>Pacing — run-rate + seasonality</Lbl>
        <Big color={C.blue}>{fmtK(slow?.pacing?.yearProj)}</Big>
        <Trio items={[[fmtK(slow?.pacing?.monthProj), 'month lands', C.blue], [(slow?.pacing?.yoy >= 0 ? '+' : '') + (slow?.pacing?.yoy ?? '—') + '%', 'vs last year', C.green]]} />
      </Card>
      <Card style={{ gridColumn:'10/13' }}>
        <Lbl>True GM (burdened) — {gm?.month || 'month'}</Lbl>
        <Big color={gmCol(gm?.company)}>{gm?.company != null ? gm.company + '%' : '…'}</Big>
        <Trio items={['HVAC', 'Plumbing', 'Electrical'].map(t => [gm?.byTrade?.[t] != null ? gm.byTrade[t] + '%' : '—', TRADE_SHORT[t], gmCol(gm?.byTrade?.[t])])} />
      </Card>

      {/* Row 2 — operation */}
      <Card style={{ gridColumn:'1/4' }}>
        <Lbl>Clubs sold</Lbl>
        <Big color={C.purple}>{fmtN(day?.memberships)}</Big>
        <Trio items={[[fmtN(mon?.memberships), 'MTD'], [fmtN(yr?.memberships), 'YTD']]} />
      </Card>
      <Card style={{ gridColumn:'4/7' }}>
        <Lbl>⭐ 5-star reviews</Lbl>
        <Big color={C.amber}>{fmtN(day?.fiveStar)}</Big>
        <Trio items={[[fmtN(mon?.fiveStar), 'MTD'], [fmtN(yr?.fiveStar), 'YTD']]} />
      </Card>
      <Card style={{ gridColumn:'7/10' }}>
        <Lbl>Call center — today</Lbl>
        <Big color={C.green}>{fast?.booking?.pct != null ? fast.booking.pct + '%' : '…'}</Big>
        <Trio items={[[`${fmtN(fast?.booking?.booked)}/${fmtN(fast?.booking?.leadCalls)}`, 'booked / leads'], [fmtN(fast?.csrOutbounds), 'CSR outbounds', C.blue]]} />
      </Card>
      <Card style={{ gridColumn:'10/13' }}>
        <Lbl>Opportunities today · goal {fast?.opps?.goal || 33}</Lbl>
        <Big color={oppPct >= 100 ? C.green : oppPct >= 70 ? C.amber : C.red}>{fmtN(fast?.opps?.total)}</Big>
        <div style={{ height:10, borderRadius:5, background:'#1B2734', margin:'6px 0' }}>
          <div style={{ height:'100%', width:`${oppPct}%`, borderRadius:5, background: oppPct >= 100 ? C.green : oppPct >= 70 ? C.amber : C.red }} />
        </div>
        <Trio items={['HVAC', 'Plumbing', 'Electrical'].map(t => [fmtN(fast?.opps?.byTrade?.[t] || 0), TRADE_SHORT[t]])} />
      </Card>

      {/* Row 3 — the year + leads */}
      <Card style={{ gridColumn:'1/9' }}>
        <Lbl>The year — monthly actual → projected ($k) · dots = last year</Lbl>
        <div style={{ flex:1, minHeight:0 }}><YearChart slow={slow} /></div>
      </Card>
      <Card style={{ gridColumn:'9/13' }}>
        <Lbl>Lead calls today · goal {fast?.leads?.goal || 43}</Lbl>
        <div style={{ display:'flex', alignItems:'baseline', gap:14 }}>
          <Big color={(fast?.leads?.total || 0) >= (fast?.leads?.goal || 43) ? C.green : C.amber}>{fmtN(fast?.leads?.total)}</Big>
          <div style={{ color:C.muted, fontSize:'clamp(11px,1vw,14px)' }}>
            {['HVAC', 'Plumbing', 'Electrical', 'Garage Doors'].map(t => `${TRADE_SHORT[t]} ${fast?.leads?.byTrade?.[t] || 0}`).join(' · ')}
          </div>
        </div>
        <div style={{ height:10, borderRadius:5, background:'#1B2734', margin:'8px 0' }}>
          <div style={{ height:'100%', width:`${Math.min(100, Math.round((fast?.leads?.total || 0) / (fast?.leads?.goal || 43) * 100))}%`, borderRadius:5, background:C.green }} />
        </div>
        <Lbl>Live activity</Lbl>
        <div style={{ flex:1, overflow:'hidden', fontSize:'clamp(11px,1vw,14px)', lineHeight:1.75 }}>
          {feed.map((f, i) => (
            <div key={i} style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', borderBottom:`1px solid ${C.border}` }}>
              {f.kind === 'sale' && <span><b style={{ color:C.green }}>{fmtMoney(f.amount)} sold</b>{f.who ? ` — ${f.who}` : ''}</span>}
              {f.kind === 'review' && <span>⭐⭐⭐⭐⭐ {f.who}{f.text ? ` ${f.text}` : ''}</span>}
              {f.kind === 'membership' && <span style={{ color:C.purple }}>Club sold{f.who ? ` — ${f.who}` : ''}</span>}
              {f.kind === 'invoice' && <span><b>{fmtMoney(f.amount)} invoiced</b>{f.who ? ` — ${f.who}` : ''}</span>}
            </div>
          ))}
          {!feed.length && <div style={{ color:C.dim }}>Quiet so far today…</div>}
        </div>
      </Card>

      {/* Row 4 — people + nothing else */}
      <Card style={{ gridColumn:'1/9' }}>
        <Lbl>Top 5 techs — {fmtDate(time, { month:'long' })} · composite score</Lbl>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead><tr>{th('#', false)}{th('Technician', false)}{th('Score')}{th('Sold')}{th('Avg ticket')}{th('Close')}{th('5★')}{th('Clubs')}{th('YTD sold')}</tr></thead>
          <tbody>
            {techs.map((x, i) => (
              <tr key={x.id || i} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${C.orange}12` : 'transparent' }}>
                <td style={{ padding:'2px 6px', width:26 }}><Rank i={i} /></td>
                <td style={{ padding:'2px 6px', fontWeight:700, whiteSpace:'nowrap', fontSize:'clamp(11px,1vw,15px)' }}>
                  {x.name}{x.trade && <span style={{ marginLeft:6, fontSize:9, fontWeight:800, color:C.dim }}>{TRADE_SHORT[x.trade] || x.trade}</span>}
                </td>
                {cell(x.score, fmtN, C.blue)}{cell(x.sold, fmtMoney, C.green)}{cell(x.avgTicket, fmtMoney)}
                {cell(x.closeRate, (v) => v == null ? '—' : Math.round(v * 100) + '%', C.amber)}
                {cell(x.fiveStar)}{cell(x.memberships, fmtN, C.purple)}{cell(x.ytd?.sold, fmtK, C.green)}
              </tr>
            ))}
          </tbody>
        </table>
        <Lbl>Top 5 CSRs — {csr?.month || ''}</Lbl>
        <table style={{ width:'100%', borderCollapse:'collapse' }}>
          <thead><tr>{th('#', false)}{th('CSR', false)}{th('Score')}{th('Booked')}{th('Book rate')}{th('Lead calls')}{th('Clubs')}{th('QA (Andi)')}</tr></thead>
          <tbody>
            {csrs.map((x, i) => (
              <tr key={x.name} style={{ borderBottom:`1px solid ${C.border}`, background: i === 0 ? `${C.blue}12` : 'transparent' }}>
                <td style={{ padding:'2px 6px', width:26 }}><Rank i={i} /></td>
                <td style={{ padding:'2px 6px', fontWeight:700, fontSize:'clamp(11px,1vw,15px)' }}>{x.name}</td>
                {cell(x.score, fmtN, C.blue)}{cell(x.booked, fmtN, C.green)}
                {cell(x.rate, (v) => Math.round(v * 100) + '%', C.amber)}
                {cell(x.leadCalls)}{cell(x.clubs, fmtN, C.purple)}
                {cell(x.qa, (v) => v == null ? '—' : Number(v).toFixed(1))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card style={{ gridColumn:'9/13' }}>
        <Lbl>Company — month</Lbl>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'clamp(11px,1vw,15px)' }}>
          <tbody>
            {[['Close rate', mon?.closeRate != null ? Math.round(mon.closeRate * 100) + '%' : '—', C.amber],
              ['Jobs ran', fmtN(mon?.jobsRan), C.text],
              ['Sold count', fmtN(mon?.soldCount), C.green],
              ['Avg sale', mon?.soldCount ? fmtMoney(mon.sales / mon.soldCount) : '—', C.text],
              ['Clubs', fmtN(mon?.memberships), C.purple],
              ['5★ reviews', fmtN(mon?.fiveStar), C.amber],
            ].map(([k, v, col]) => (
              <tr key={k} style={{ borderBottom:`1px solid ${C.border}` }}>
                <td style={{ padding:'4px 6px', color:C.muted }}>{k}</td>
                <td style={{ padding:'4px 6px', textAlign:'right', fontWeight:800, color:col }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop:'auto', fontSize:10, color:C.dim }}>
          GM = revenue − POs − burdened field labor (22.4%) · pacing = run-rate × 2025 seasonality · opps goal 33/eff-day ($20.5M plan)
        </div>
      </Card>
    </div>
  )
}
