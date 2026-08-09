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

// Accepts either ADP file: the payroll INVOICE (exact burden per employee) or
// the payroll REGISTER (real departments + hours, burden estimated).
export function parseAdpUpload(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' })
  return parseAdpPayrollRegister(wb) || parseAdpPayrollInvoice(wb)
}

export function parseAdpPayrollInvoice(wb) {
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
  meta.type = 'invoice'
  return { meta, employees }
}

// Burden rates measured from the Aug 2026 invoices — used only for REGISTER
// uploads, where the employer-cost columns don't exist. Overridable via
// app_settings.labor_burden.
export const REGISTER_BURDEN_DEFAULTS = { fieldSvcRate: 0.1615, officeSvcRate: 0.1402, erAdjPct: 0.041 }

// ── Payroll REGISTER parser (PR_PayrollRegister_*.xls) ──────────────────────
// The register is the other report Brandyn can download. It has REAL ADP
// departments inline ("Paid-In Department - 001500 - HVAC Install") and hours,
// but no employer-burden columns — those get estimated from the measured
// TotalSource rates (service fee % by class + ER 401k/HSA % + benefits share
// from the benefits-invoice mapping).
const parseNum = (v) => Number(String(v ?? '').replace(/[, ]/g, '')) || 0

export function parseAdpPayrollRegister(wb) {
  const info = wb.Sheets['Payroll Info']
  const reg = wb.Sheets['Payroll Register']
  if (!info || !reg) return null
  const infoRows = XLSX.utils.sheet_to_json(info, { header: 1, raw: false })
  const meta = { type: 'register' }
  for (const r of infoRows) {
    const k = String(r?.[0] || '').trim()
    if (k === 'P/E Date') {
      const m = String(r[1] || '').match(/(\d{2})\/(\d{2})\/(\d{4})/)
      if (m) meta.periodEnd = `${m[3]}-${m[1]}-${m[2]}`
    }
    if (k === 'Week#') meta.weekNo = String(r[1] || '')
  }
  if (!meta.periodEnd) throw new Error('Register has no P/E Date')
  meta.invoiceNo = `register wk ${meta.weekNo || '?'}`

  const rows = XLSX.utils.sheet_to_json(reg, { header: 1, raw: false })
  const employees = []
  let dept = ''
  let last = null
  for (const r of rows) {
    const c0 = String(r?.[0] || '')
    const hdr = c0.match(/^Paid-In Department\s*-\s*\d+\s*-\s*(.+)$/)
    if (hdr) { dept = hdr[1].trim(); last = null; continue }
    if (c0.includes('Associate ID:')) {
      // An employee row's first cell holds "Last,  First\nAssociate ID: ..."
      const name = c0.split('\n')[0].replace(/\s+/g, ' ').trim()
      last = {
        name,
        dept,
        hours: parseNum(r[1]) + parseNum(r[2]),   // Reg + O/T
        gross: parseNum(r[8]),
        // burden columns don't exist on the register — estimated in aggregate
        feesTaxes: null,
        erAdj: null,
      }
      employees.push(last)
      continue
    }
    // Second vouchers (commission pays etc.) continue the previous employee as
    // "W-In Dept: ..." rows with their own gross — without this, commission-
    // heavy weeks under-count by five figures.
    if (c0.includes('W-In Dept:') && last) {
      last.gross += parseNum(r[8])
      last.hours += parseNum(r[1]) + parseNum(r[2])
    }
  }
  if (!employees.length) throw new Error('No employee rows found in register')
  return { meta, employees }
}

// Sunday on-or-after the period end (End Date is normally already a Sunday).
const weekEndOf = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const dow = d.getUTCDay()
  if (dow !== 0) d.setUTCDate(d.getUTCDate() + (7 - dow))
  return d.toISOString().slice(0, 10)
}

export function aggregateAdpActuals(parsed, deptMap, rates = REGISTER_BURDEN_DEFAULTS) {
  const employees = deptMap?.employees || {}
  const mk = () => ({ gross: 0, cost: 0, hours: 0, n: 0 })
  const byTrade = {}, byDept = {}
  const totals = { gross: 0, cost: 0, hours: 0, field: mk(), office: mk() }
  const unmatched = []
  for (const e of parsed.employees) {
    const m = employees[e.name.toLowerCase()] || null
    const benWk = m ? (Number(m.ben_month) || 0) * 12 / 52 : 0
    // Register rows know their department; invoice rows need the mapping.
    const dept = e.dept || m?.dept || '(unmapped)'
    const trade = tradeOf(dept) || 'Office/Overhead'
    const isField = e.wc != null && e.wc !== '' ? e.wc.startsWith('5537') : trade !== 'Office/Overhead'
    const cost = e.feesTaxes != null
      ? e.gross + e.feesTaxes + e.erAdj + benWk   // invoice: exact
      : e.gross * (1 + (isField ? rates.fieldSvcRate : rates.officeSvcRate) + rates.erAdjPct) + benWk   // register: estimated
    if (!m && !e.dept) unmatched.push(e.name)
    for (const bucket of [byTrade[trade] = byTrade[trade] || mk(), byDept[dept] = byDept[dept] || mk(), totals[isField ? 'field' : 'office']]) {
      bucket.gross += e.gross; bucket.cost += cost; bucket.hours += e.hours || 0; bucket.n++
    }
    totals.gross += e.gross; totals.cost += cost; totals.hours += e.hours || 0
  }
  const r0 = (n) => Math.round(n)
  const round = (o) => ({ gross: r0(o.gross), cost: r0(o.cost), hours: r0(o.hours), n: o.n })
  return {
    weekEnd: weekEndOf(parsed.meta.periodEnd),
    invoiceNo: parsed.meta.invoiceNo || null,
    periodEnd: parsed.meta.periodEnd,
    source: parsed.meta.type || 'invoice',
    approx: parsed.meta.type === 'register',   // burden estimated from rates
    employees: parsed.employees.length,
    unmatched,
    totals: { gross: r0(totals.gross), cost: r0(totals.cost), hours: r0(totals.hours), field: round(totals.field), office: round(totals.office) },
    byTrade: Object.fromEntries(Object.entries(byTrade).map(([k, v]) => [k, round(v)])),
    byDept: Object.fromEntries(Object.entries(byDept).map(([k, v]) => [k, round(v)])),
  }
}
