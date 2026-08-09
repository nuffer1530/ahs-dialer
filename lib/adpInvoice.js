// ── ADP TotalSource payroll invoice parser ──────────────────────────────────
//
// Brandyn downloads the weekly payroll invoice (legacy .xls) from the
// TotalSource portal and drops it on the Leadership page. This turns it into
// per-department TRUE labor: gross + the bundled service fee (admin + workers
// comp + employer taxes, which is exactly what TOTAL SVC FEE AMT holds) +
// employer 401k/HSA contributions + the employer share of benefit premiums
// (monthly, from the benefits-invoice mapping, converted ×12/52).
//
// Department attribution comes from `app_settings.adp_employee_depts`, seeded
// from the ADP *benefits* invoice (the payroll invoice has no dept column).
// Employees missing from the mapping are reported, not silently dropped.

import XLSX from 'xlsx'

// Employer-cost adjustment columns; employee-paid deductions and reimbursements
// are pass-throughs, not labor burden.
const ER_ADJ_KEYS = ['401K MATCH', 'HSA ER', 'NEW HIRE FEE']

const tradeOf = (name) => {
  const n = (name || '').toLowerCase()
  if (n.includes('hvac')) return 'HVAC'
  if (n.includes('plumb')) return 'Plumbing'
  if (n.includes('electric')) return 'Electrical'
  if (n.includes('garage')) return 'Garage Doors'
  return null
}

const excelDate = (serial) => {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10)
}

export function parseAdpPayrollInvoice(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })

  const meta = {}
  for (const r of rows.slice(0, 15)) {
    const k = String(r?.[0] || '').trim()
    if (k === 'Invoice No') meta.invoiceNo = String(r[1] ?? '').replace(/\.0$/, '')
    if (k === 'Reference No') meta.referenceNo = String(r[1] ?? '')
    if (k === 'Total Amount') meta.totalAmount = Number(r[1]) || null
    if (k === 'End Date') meta.periodEnd = excelDate(r[1])
    if (k === 'Pay Date') meta.payDate = excelDate(r[1])
  }
  if (!meta.periodEnd) throw new Error('Not an ADP payroll invoice — no End Date in company-info block')

  const hdrIdx = rows.findIndex(r => String(r?.[0] || '').trim() === 'NAME')
  if (hdrIdx < 0) throw new Error('Not an ADP payroll invoice — no NAME header row')
  const headers = rows[hdrIdx].map(h => String(h || '').trim())
  const col = (name) => headers.indexOf(name)
  const cGross = col('GROSS'), cFees = col('TOTAL SVC FEE AMT'), cWc = col('WC CODE')
  if (cGross < 0 || cFees < 0) throw new Error('Unrecognized layout — missing GROSS / TOTAL SVC FEE AMT columns')
  const erCols = headers.map((h, i) => (h.startsWith('ADJ') && ER_ADJ_KEYS.some(k => h.toUpperCase().includes(k))) ? i : -1).filter(i => i >= 0)

  const employees = []
  for (const r of rows.slice(hdrIdx + 1)) {
    const name = String(r?.[0] || '').trim()
    if (!name || name.startsWith('Company Total') || name.startsWith('TABLE')) break
    const num = (i) => Number(r[i]) || 0
    employees.push({
      name,
      wc: String(r[cWc] ?? '').trim(),
      gross: num(cGross),
      feesTaxes: num(cFees),
      erAdj: erCols.reduce((a, i) => a + num(i), 0),
    })
  }
  if (!employees.length) throw new Error('No employee rows found')
  return { meta, employees }
}

// Sunday on-or-after the period end (End Date is normally already a Sunday).
const weekEndOf = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const dow = d.getUTCDay()
  if (dow !== 0) d.setUTCDate(d.getUTCDate() + (7 - dow))
  return d.toISOString().slice(0, 10)
}

export function aggregateAdpActuals(parsed, deptMap) {
  const employees = deptMap?.employees || {}
  const mk = () => ({ gross: 0, cost: 0, n: 0 })
  const byTrade = {}, byDept = {}
  const totals = { gross: 0, cost: 0, field: mk(), office: mk() }
  const unmatched = []
  for (const e of parsed.employees) {
    const m = employees[e.name.toLowerCase()] || null
    const benWk = m ? (Number(m.ben_month) || 0) * 12 / 52 : 0
    const cost = e.gross + e.feesTaxes + e.erAdj + benWk
    if (!m) unmatched.push(e.name)
    const dept = m?.dept || '(unmapped)'
    const trade = tradeOf(dept) || 'Office/Overhead'
    const cls = e.wc.startsWith('5537') ? 'field' : 'office'
    for (const bucket of [byTrade[trade] = byTrade[trade] || mk(), byDept[dept] = byDept[dept] || mk(), totals[cls]]) {
      bucket.gross += e.gross; bucket.cost += cost; bucket.n++
    }
    totals.gross += e.gross; totals.cost += cost
  }
  const r0 = (n) => Math.round(n)
  const round = (o) => ({ gross: r0(o.gross), cost: r0(o.cost), n: o.n })
  return {
    weekEnd: weekEndOf(parsed.meta.periodEnd),
    invoiceNo: parsed.meta.invoiceNo || null,
    periodEnd: parsed.meta.periodEnd,
    employees: parsed.employees.length,
    unmatched,
    totals: { gross: r0(totals.gross), cost: r0(totals.cost), field: round(totals.field), office: round(totals.office) },
    byTrade: Object.fromEntries(Object.entries(byTrade).map(([k, v]) => [k, round(v)])),
    byDept: Object.fromEntries(Object.entries(byDept).map(([k, v]) => [k, round(v)])),
  }
}
