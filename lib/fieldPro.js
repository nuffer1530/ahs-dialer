// ── Field Pro (Siro): in-home conversation recordings for field techs ───────
//
// Siro records the tech's conversation in the customer's home, scores it on a
// per-trade scorecard, writes AI summaries, and flags "Re-Engage" follow-ups
// (unsold work worth another call). Andi mirrors all of it into Supabase
// (siro_* tables, service key only) so the Team page, department TVs, the 7 AM
// digest and the Re-Engage emails never wait on — or break with — Siro.
//
// Two credentials:
//  • SIRO_API_TOKEN — the org API token (functions.siro.ai). Recordings,
//    summaries, the overall evaluationScore and full follow-ups. Siro is
//    retiring org tokens: 30 days after "client apps" launch no new ones can
//    be made, 9 months after that they stop working (no dates published).
//  • A read token for api.siro.ai — the per-rubric scorecards. Today that's a
//    legacy OAuth app (siro_auth row: client id/secret, bound to Brandyn's
//    Siro user, scope 'read'), re-minted with the org token as it expires.
//    When Siro turns on client apps, set SIRO_CLIENT_ID / SIRO_CLIENT_SECRET
//    and this uses auth.siro.ai client_credentials instead — nothing else
//    changes. Everything scorecard-shaped degrades to the org-token data
//    (average evaluationScore) when no read token is available.
//
// Gotchas (verified Sep 25, 2026): list pages above ~40 items silently return
// evaluationScore null (we use 25); follow-ups on the list are {id, score}
// only — GET /recordings/{id}?showFollowups=true has the full payload;
// Siro's opportunity externalId IS the ServiceTitan job id; users.externalId
// is the ST technician (or employee) id; recordings carry rootDataPurgedAt,
// so what we pull is kept here rather than re-fetched later.

const FN = 'https://functions.siro.ai/api-externalApi'
const API = 'https://api.siro.ai'
const AUTH = 'https://auth.siro.ai/oauth2/token'
const UA = 'Andi/1.0 (curl-compatible)'
const DENVER = 'America/Denver'
// Aug 12 was a batch of test clips; real recording started Sep 25, 2026.
const EPOCH = '2026-08-01T00:00:00.000Z'
// Order matters: "Garage Door Repair" / "Water Heater" must not read as HVAC.
const TRADE_RE = [['Plumbing', /plumb|water heater/i], ['Electrical', /electric/i], ['Garage Doors', /garage/i], ['HVAC', /hvac|\bheat|\bair\b|furnace|cooling/i]]
export const FIELD_TRADES = ['HVAC', 'Plumbing', 'Electrical', 'Garage Doors']

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Denver midnight for YYYY-MM-DD as a UTC ISO string (DST-correct).
// Checks the offset AT midnight, not at noon — on a fall-back day (Nov 1,
// 2026) midnight is still MDT while noon is MST.
export function denverMidnightIso(dateStr) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: DENVER, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
  for (const h of [6, 7]) {
    const d = new Date(`${dateStr}T0${h}:00:00Z`)
    const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]))
    if (`${p.year}-${p.month}-${p.day}` === dateStr && Number(p.hour) === 0) return d.toISOString()
  }
  return new Date(`${dateStr}T07:00:00Z`).toISOString()
}
export const denverYmd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: DENVER }).format(d)
export const denverYm = (d = new Date()) => denverYmd(d).slice(0, 7)
const denverHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: DENVER, hour: '2-digit', hour12: false }).format(new Date())) % 24
export const shiftYm = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7) }
export const monthBounds = (ym) => ({ startIso: denverMidnightIso(`${ym}-01`), endIso: denverMidnightIso(`${shiftYm(ym, 1)}-01`) })
const tradeOfName = (name) => (TRADE_RE.find(([, re]) => re.test(name || '')) || [null])[0]

// Siro's color bands (RED 0–49, YELLOW 50–79, GREEN 80–100).
export const fieldTone = (p) => (p == null ? 'gray' : p >= 80 ? 'green' : p >= 50 ? 'amber' : 'red')

export function createFieldPro({ supabase, stGet, tenantId, sendResend, techMeta, anthropicKey, orgToken, clientId, clientSecret }) {
  const ORG = { id: null }
  const withTimeout = async (url, opts = {}, ms = 25_000) => {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), ms)
    try { return await fetch(url, { ...opts, signal: ac.signal }) } finally { clearTimeout(t) }
  }
  const readJson = async (r) => { const t = await r.text(); try { return t ? JSON.parse(t) : null } catch { return { raw: t.slice(0, 200) } } }

  // ── Credentials ────────────────────────────────────────────────────────────
  let clientTok = { token: null, exp: 0 }
  async function clientAppToken() {
    if (!clientId || !clientSecret) return null
    if (clientTok.token && clientTok.exp - Date.now() > 5 * 60_000) return clientTok.token
    const r = await withTimeout(AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
    })
    const b = await readJson(r)
    if (!r.ok || !b?.access_token) throw new Error(`Siro client app token ${r.status}`)
    clientTok = { token: b.access_token, exp: Date.now() + (Number(b.expires_in) || 3600) * 1000 }
    return clientTok.token
  }
  const orgAuth = async () => (orgToken ? `Bearer ${orgToken}` : (await clientAppToken()) ? `Bearer ${clientTok.token}` : null)

  async function orgGet(path) {
    const auth = await orgAuth()
    if (!auth) throw new Error('No Siro credential (SIRO_API_TOKEN)')
    for (let attempt = 0; ; attempt++) {
      const r = await withTimeout(`${FN}${path}`, { headers: { Authorization: auth, 'User-Agent': UA, Accept: 'application/json' } })
      if (r.status === 429 && attempt < 2) { await sleep(3000 * (attempt + 1)); continue }
      const b = await readJson(r)
      if (!r.ok) throw new Error(`Siro ${r.status} ${path.split('?')[0]}: ${JSON.stringify(b).slice(0, 160)}`)
      return b
    }
  }
  async function orgPost(path, body) {
    const r = await withTimeout(`${FN}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${orgToken}`, 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) })
    const b = await readJson(r)
    if (!r.ok) throw new Error(`Siro ${r.status} ${path.split('/').slice(0, 5).join('/')}`)
    return b?.data ?? b
  }

  // Legacy OAuth read token: reuse the stored one until ~1h before expiry.
  let userTok = { token: null, exp: 0 }
  async function legacyToken(force) {
    if (!force && userTok.token && userTok.exp - Date.now() > 60 * 60_000) return userTok.token
    const { data: row } = await supabase.from('siro_auth').select('*').eq('id', 'default').maybeSingle()
    if (!row?.client_id || !row?.client_secret || !orgToken) return null
    const exp = row.expires_at ? Date.parse(row.expires_at) : 0
    if (!force && row.access_token && exp - Date.now() > 60 * 60_000) {
      userTok = { token: row.access_token, exp }
      return row.access_token
    }
    const t = await orgPost(`/v1/core/oauth/apps/${row.client_id}/access-token`, { clientSecret: row.client_secret, userId: row.bound_user_id || row.owner_user_id, scope: 'read' })
    let expiresAt = null
    try {
      const info = await orgGet(`/v1/core/oauth/apps/${row.client_id}/access-token/${t.accessTokenId}`)
      expiresAt = (info?.data ?? info)?.expiresAt || null
    } catch {}
    expiresAt = expiresAt || new Date(Date.now() + 23 * 3600_000).toISOString()
    await supabase.from('siro_auth').update({ access_token: t.accessToken, access_token_id: t.accessTokenId, expires_at: expiresAt, updated_at: new Date().toISOString() }).eq('id', 'default')
    userTok = { token: t.accessToken, exp: Date.parse(expiresAt) }
    console.log('field pro: minted a new Siro read token')
    return t.accessToken
  }
  async function apiGet(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await clientAppToken().catch(() => null)
      const tok = client || await legacyToken(attempt > 0)
      if (!tok) return null
      const headers = client ? { Authorization: `Bearer ${tok}`, 'x-siro-auth-token': tok } : { 'x-siro-auth-token': tok }
      const r = await withTimeout(`${API}${path}`, { headers: { ...headers, 'User-Agent': UA, Accept: 'application/json' } }, 40_000)
      if (r.status === 401 && attempt === 0 && !client) continue   // expired early → re-mint once
      const b = await readJson(r)
      if (!r.ok) throw new Error(`Siro API ${r.status} ${path.split('?')[0]}: ${JSON.stringify(b).slice(0, 160)}`)
      return b?.data ?? b
    }
    return null
  }
  const hasReadToken = async () => !!((await clientAppToken().catch(() => null)) || (await legacyToken().catch(() => null)))

  // ── Directory: Siro user → ST technician ──────────────────────────────────
  let _users = { at: 0, map: new Map() }
  async function siroUsers() {
    if (Date.now() - _users.at < 60 * 60_000 && _users.map.size) return _users.map
    const out = new Map()
    let cursor = null
    for (let i = 0; i < 20; i++) {
      const d = await orgGet(`/v1/core/users?pageSize=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      for (const u of (d?.data || [])) {
        if (!ORG.id && u.organizationId) ORG.id = u.organizationId
        out.set(u.id, {
          id: u.id, email: u.email || null, disabled: !!u.disabled, teamId: u.memberTeamId || null,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || 'Unknown',
          stTechId: u.externalId ? String(u.externalId) : null,
        })
      }
      cursor = d?.cursor
      if (!cursor || !(d?.data || []).length) break
    }
    _users = { at: Date.now(), map: out }
    return out
  }
  async function orgId() {
    if (!ORG.id) { try { await siroUsers() } catch {} }
    if (!ORG.id) {
      try { const c = await orgGet('/v1/core/auth/caller-identity'); ORG.id = (c?.data ?? c)?.organizationId || null } catch {}
    }
    return ORG.id
  }
  // ST roster lookups must never sink a Siro sync — degrade to no trade info.
  const safeMeta = async () => { try { return await techMeta() } catch (e) { console.warn('field pro tech meta:', e.message); return new Map() } }
  // Who a Siro user is in Andi terms: ST tech id, display name, trade.
  async function whoIs(siroUserId, fallbackStId) {
    const users = await siroUsers()
    const u = users.get(siroUserId) || {}
    const stId = u.stTechId || (fallbackStId ? String(fallbackStId) : null)
    const meta = stId ? (await safeMeta()).get(stId) : null
    return { stTechId: stId, name: meta?.name || u.name || null, trade: meta?.trade || null, email: u.email || null, roster: !!meta?.roster, install: !!meta?.install }
  }

  // ── ServiceTitan enrichment: job number + customer name ───────────────────
  async function stJobInfo(jobIds) {
    const ids = [...new Set(jobIds.filter(Boolean).map(String))]
    const jobs = new Map()
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const d = await stGet(`/jpm/v2/tenant/${tenantId}/jobs?ids=${ids.slice(i, i + 50).join(',')}&pageSize=50`)
        for (const j of (d?.data || [])) jobs.set(String(j.id), { jobNumber: j.jobNumber || null, customerId: j.customerId ? String(j.customerId) : null })
      } catch (e) { console.warn('field pro st jobs:', e.message) }
    }
    const custIds = [...new Set([...jobs.values()].map(j => j.customerId).filter(Boolean))]
    const names = new Map()
    for (let i = 0; i < custIds.length; i += 50) {
      try {
        const d = await stGet(`/crm/v2/tenant/${tenantId}/customers?ids=${custIds.slice(i, i + 50).join(',')}&pageSize=50`)
        for (const c of (d?.data || [])) names.set(String(c.id), c.name || null)
      } catch (e) { console.warn('field pro st customers:', e.message) }
    }
    for (const j of jobs.values()) j.customerName = j.customerId ? names.get(j.customerId) || null : null
    return jobs
  }

  // ── Recording + follow-up sync (org token) ────────────────────────────────
  const SHOW = 'showSummary=true&showEvaluationScore=true&showFollowups=true&showCrmLinks=true'
  async function pageRecordings(filter, cap = 80) {
    const out = []
    let cursor = null
    for (let i = 0; i < cap; i++) {
      const d = await orgGet(`/v1/core/recordings?pageSize=25&${filter}&${SHOW}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      out.push(...(d?.data || []))
      cursor = d?.cursor
      if (!cursor || !(d?.data || []).length) break
    }
    return out
  }

  let _syncBusy = false
  async function syncRecordings() {
    if (_syncBusy || !(orgToken || clientId)) return null
    _syncBusy = true
    const startedAt = new Date()
    try {
      const { data: st } = await supabase.from('sync_state').select('*').eq('key', 'siro_recordings').maybeSingle()
      const since = st?.last_synced_at ? new Date(Date.parse(st.last_synced_at) - 10 * 60_000).toISOString() : EPOCH
      const byId = new Map()
      for (const r of await pageRecordings(`updatedAt:gte=${since}`)) byId.set(r.id, r)
      // Scores and summaries land minutes after upload and may not bump
      // updatedAt — re-read the last 2 days' recordings still missing either.
      // (Clips under 3 minutes often never get scored; don't chase those.)
      const { data: pending } = await supabase.from('siro_recordings').select('id')
        .gte('recorded_at', new Date(Date.now() - 2 * 86400_000).toISOString()).gt('duration_sec', 180)
        .or('evaluation_score.is.null,summary.is.null').limit(60)
      for (const p of (pending || [])) {
        if (byId.has(p.id)) continue
        try { const d = await orgGet(`/v1/core/recordings/${encodeURIComponent(p.id)}?${SHOW}`); const r = d?.data ?? d; if (r?.id) byId.set(r.id, r) } catch {}
      }
      // A ServiceTitan hiccup left some rows without job # / customer — retry.
      await backfillJobInfo()
      const recs = [...byId.values()]
      if (!recs.length) {
        await supabase.from('sync_state').upsert({ key: 'siro_recordings', last_synced_at: startedAt.toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'key' })
        return { recordings: 0, followups: 0 }
      }
      const gone = recs.filter(r => r.deleted).map(r => r.id)
      const live = recs.filter(r => !r.deleted)
      if (gone.length) {
        await supabase.from('siro_recordings').delete().in('id', gone)
        await supabase.from('siro_followups').delete().in('recording_id', gone)
      }
      // Never let a list page's null overwrite a score/summary we already have.
      const existing = new Map()
      for (let i = 0; i < live.length; i += 100) {
        const { data } = await supabase.from('siro_recordings').select('id, evaluation_score, summary, job_number, customer_name, st_customer_id')
          .in('id', live.slice(i, i + 100).map(r => r.id))
        for (const e of (data || [])) existing.set(e.id, e)
      }
      const now = new Date().toISOString()
      const rows = []
      for (const r of live) {
        const who = await whoIs(r.userId, r.crm?.users?.[0]?.externalId)
        const ex = existing.get(r.id) || {}
        const summary = Array.isArray(r.summary) && r.summary.length ? r.summary.map(s => ({ name: s.name, content: s.content })) : (ex.summary || null)
        rows.push({
          id: r.id, siro_user_id: r.userId, st_tech_id: who.stTechId, tech_name: who.name, trade: who.trade,
          title: r.title || null, recorded_at: r.createdAt, siro_updated_at: r.updatedAt,
          duration_sec: Math.round((Number(r.durationInMilliseconds) || 0) / 1000), result: r.result || null,
          evaluation_score: r.evaluationScore ?? ex.evaluation_score ?? null, summary,
          st_job_id: r.crm?.opportunity?.externalId ? String(r.crm.opportunity.externalId) : null,
          job_number: ex.job_number || null, customer_name: ex.customer_name || null, st_customer_id: ex.st_customer_id || null,
          followup_ids: (r.followups || []).map(f => f.id || f.followupId).filter(Boolean),
          web_url: r.links?.web?.self || null, synced_at: now,
        })
      }
      // ST job number + customer for rows that don't have them yet.
      const need = rows.filter(r => r.st_job_id && !r.job_number)
      if (need.length) {
        const info = await stJobInfo(need.map(r => r.st_job_id))
        for (const r of need) {
          const j = info.get(r.st_job_id)
          if (j) { r.job_number = j.jobNumber; r.customer_name = j.customerName; r.st_customer_id = j.customerId }
        }
      }
      for (let i = 0; i < rows.length; i += 100) {
        const { error } = await supabase.from('siro_recordings').upsert(rows.slice(i, i + 100), { onConflict: 'id' })
        if (error) throw new Error(`siro_recordings upsert: ${error.message}`)
      }

      // Follow-ups: the list only carries {id, score}; the recording's own
      // GET has the full Re-Engage payload (drafts, objections, timing).
      const withFu = rows.filter(r => r.followup_ids.length)
      const recById = new Map(rows.map(r => [r.id, r]))
      const fuRows = []
      let fuFailed = false
      for (const r of withFu) {
        let full
        try { const d = await orgGet(`/v1/core/recordings/${encodeURIComponent(r.id)}?showFollowups=true`); full = d?.data ?? d }
        catch (e) { console.warn('field pro followups:', e.message); fuFailed = true; continue }
        for (const f of (full?.followups || [])) {
          const rec = recById.get(f.recordingId) || r
          const who = await whoIs(f.repId || rec.siro_user_id)
          const cc = f.crmCustomer || {}
          fuRows.push({
            id: f.followupId, recording_id: f.recordingId || r.id,
            siro_user_id: f.repId || rec.siro_user_id, st_tech_id: who.stTechId || rec.st_tech_id,
            tech_name: who.name || rec.tech_name, trade: who.trade || rec.trade,
            followup_type: f.followupType || null, score: f.score ?? null, status: f.status || null,
            context: Object.fromEntries((f.context || []).map(c => [c.header, c.value])),
            thinking: f.thinking || null,
            // crmCustomer.externalId is the opportunity (= ST job) only when
            // the customer record IS the opportunity.
            st_job_id: String(cc.opportunityExternalId || (cc.customerType === 'OPPORTUNITY' ? cc.externalId : '') || rec.st_job_id || '') || null,
            job_number: rec.job_number || null, customer_name: rec.customer_name || null, st_customer_id: rec.st_customer_id || null,
            created_at: f.dateCreated || rec.recorded_at, siro_updated_at: f.updatedAt || null, synced_at: now,
          })
        }
      }
      const fuNeed = fuRows.filter(f => f.st_job_id && !f.customer_name)
      if (fuNeed.length) {
        const info = await stJobInfo(fuNeed.map(f => f.st_job_id))
        for (const f of fuNeed) { const j = info.get(f.st_job_id); if (j) { f.job_number = j.jobNumber; f.customer_name = j.customerName; f.st_customer_id = j.customerId } }
      }
      for (let i = 0; i < fuRows.length; i += 100) {
        const { error } = await supabase.from('siro_followups').upsert(fuRows.slice(i, i + 100), { onConflict: 'id' })
        if (error) throw new Error(`siro_followups upsert: ${error.message}`)
      }
      // Each scored call's own scorecard — feeds "which steps go with won
      // jobs" in the LT agenda's coaching focus. ~25 per tick keeps up with
      // the ~45 recordings a day.
      await backfillRecordingScorecards()
      // A failed follow-up fetch holds the watermark so that recording comes
      // back next run — otherwise its Re-Engage lead would never be emailed.
      if (!fuFailed) await supabase.from('sync_state').upsert({ key: 'siro_recordings', last_synced_at: startedAt.toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (rows.length || fuRows.length) console.log(`field pro: synced ${rows.length} recordings, ${fuRows.length} follow-ups`)
      return { recordings: rows.length, followups: fuRows.length }
    } catch (e) {
      console.warn('field pro sync:', e.message)
      return { error: e.message }
    } finally { _syncBusy = false }
  }

  // Marking a lead done in Siro doesn't touch the recording, so the org-token
  // sync never sees it — the read token's follow-up list does. Status only;
  // new follow-ups still arrive (with the full payload) through syncRecordings.
  async function refreshFollowupStatuses() {
    try {
      if (!(await hasReadToken())) return null
      const org = await orgId()
      const since = new Date(Date.now() - 30 * 86400_000).toISOString()
      const seen = []
      let cursor = null
      for (let i = 0; i < 20; i++) {
        const d = await apiGet(`/v1/core/followups?organizationId=${org}&limit=100&minimumScore=1&createdAfter=${encodeURIComponent(since)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        const list = d?.followups || []
        seen.push(...list)
        cursor = d?.cursor
        if (!cursor || !list.length) break
      }
      let changed = 0
      for (let i = 0; i < seen.length; i += 100) {
        const chunk = seen.slice(i, i + 100)
        const { data: have } = await supabase.from('siro_followups').select('id, status').in('id', chunk.map(f => f.followupId))
        const cur = new Map((have || []).map(h => [h.id, h.status]))
        for (const f of chunk) {
          if (!cur.has(f.followupId) || cur.get(f.followupId) === f.status) continue
          await supabase.from('siro_followups').update({ status: f.status, siro_updated_at: f.updatedAt || null }).eq('id', f.followupId)
          changed++
        }
      }
      return { seen: seen.length, changed }
    } catch (e) { console.warn('field pro follow-up statuses:', e.message); return null }
  }

  // ── Per-rubric scorecards (read token) ────────────────────────────────────
  let _instances = { at: 0, list: [] }
  async function scorecardInstances() {
    if (Date.now() - _instances.at < 6 * 3600_000 && _instances.list.length) return _instances.list
    const org = await orgId()
    const d = await apiGet(`/v1/core/scorecards/instance-summaries?organizationId=${org}`)
    const list = (d?.scorecardInstances || []).filter(s => s.isActive !== false).map(s => ({ id: s.id, name: s.name, trade: tradeOfName(s.name) }))
    _instances = { at: Date.now(), list }
    return list
  }
  // Siro's node tree → sections with their metrics, in Siro's order.
  function parseEvaluation(d) {
    if (!d) return null
    const nodes = d.evaluatedNodes || []
    const kids = new Map()
    for (const n of nodes) { if (!kids.has(n.parentId)) kids.set(n.parentId, []); kids.get(n.parentId).push(n) }
    const byIdx = (a, b) => (a.indexNumber || 0) - (b.indexNumber || 0)
    const weights = new Map((d.sectionWeights || []).map(w => [w.scorecardNodeId, w.weight]))
    const root = nodes.find(n => n.nodeType === 'ROOT')
    const sections = root ? (kids.get(root.id) || []).sort(byIdx).map(s => ({
      name: s.name, weight: weights.get(s.id) ?? s.metadata?.sectionWeight ?? null, points: s.pointsEarned ?? null, color: s.color || null,
      metrics: (kids.get(s.id) || []).sort(byIdx).map(m => ({ name: String(m.name || '').trim(), points: m.pointsEarned ?? null, color: m.color || null, type: m.metadata?.metricType || null })),
    })) : []
    const evaluated = Number(d.recordingsEvaluatedCount) || 0
    return {
      points: evaluated ? (root?.pointsEarned ?? d.pointsEarned ?? null) : null,
      evaluated, total: Number(d.recordingsTotalCount) || 0, won: Number(d.recordingsWonCount) || 0,
      sections: evaluated ? sections : [],
    }
  }
  async function evaluate(instanceId, startIso, endIso, filterBy, ids) {
    const d = await apiGet(`/v1/core/scorecards/evaluated-instances/${instanceId}?startAt=${encodeURIComponent(startIso)}&endAt=${encodeURIComponent(endIso)}&filterBy=${filterBy}&filterByIds=${encodeURIComponent(ids)}`)
    return parseEvaluation(d)
  }

  let _scBusy = false
  async function syncTechScorecards(ym = denverYm()) {
    if (_scBusy) return null
    _scBusy = true
    try {
      if (!(await hasReadToken())) return { skipped: 'no read token' }
      const [instances, users, meta, org] = [await scorecardInstances(), await siroUsers(), await safeMeta(), await orgId()]
      const { startIso, endIso } = monthBounds(ym)
      const rows = []
      const now = new Date().toISOString()
      for (const inst of instances) {
        if (!inst.trade) continue
        try {
          const team = await evaluate(inst.id, startIso, endIso, 'ORGANIZATION', org)
          if (team) rows.push({ month: ym, st_tech_id: `team:${inst.trade}`, siro_user_id: null, tech_name: `${inst.trade} team`, trade: inst.trade, ...team, synced_at: now })
        } catch (e) { console.warn(`field pro team scorecard ${inst.trade}:`, e.message) }
        for (const u of users.values()) {
          const m = u.stTechId ? meta.get(u.stTechId) : null
          if (!m || m.trade !== inst.trade || !(m.roster || m.install) || u.disabled) continue
          try {
            const ev = await evaluate(inst.id, startIso, endIso, 'USER', u.id)
            if (ev) rows.push({ month: ym, st_tech_id: u.stTechId, siro_user_id: u.id, tech_name: m.name, trade: inst.trade, ...ev, synced_at: now })
          } catch (e) { console.warn(`field pro scorecard ${m.name}:`, e.message) }
        }
      }
      // One row per key — two instances mapping to one trade would otherwise
      // make Postgres reject the whole upsert.
      const uniq = [...new Map(rows.map(r => [`${r.month}|${r.st_tech_id}`, r])).values()]
      for (let i = 0; i < uniq.length; i += 100) {
        const { error } = await supabase.from('siro_tech_scorecards').upsert(uniq.slice(i, i + 100), { onConflict: 'month,st_tech_id' })
        if (error) throw new Error(error.message)
      }
      return { month: ym, rows: uniq.length }
    } catch (e) {
      console.warn('field pro scorecards:', e.message)
      return { error: e.message }
    } finally { _scBusy = false }
  }

  // One recording's own scorecard, fetched on first open and kept.
  // Only the tech's trade scorecard is tried (all four only when the trade is
  // unknown); a miss is remembered for 6h so reopening the call stays fast.
  async function recordingScorecard(rec) {
    if (rec.scorecard?.evaluated) return rec.scorecard
    if (rec.scorecard?.none && Date.now() - Date.parse(rec.scorecard_synced_at || 0) < 6 * 3600_000) return null
    if (!(await hasReadToken())) return null
    const instances = await scorecardInstances()
    const at = Date.parse(rec.recorded_at)
    const startIso = new Date(at - 2 * 86400_000).toISOString(), endIso = new Date(at + 2 * 86400_000).toISOString()
    const order = rec.trade ? instances.filter(i => i.trade === rec.trade) : instances
    for (const inst of order) {
      try {
        const ev = await evaluate(inst.id, startIso, endIso, 'RECORDING', rec.id)
        if (ev?.evaluated) {
          const sc = { ...ev, scorecard: inst.name }
          await supabase.from('siro_recordings').update({ scorecard: sc, scorecard_synced_at: new Date().toISOString() }).eq('id', rec.id)
          return sc
        }
      } catch (e) { console.warn('field pro recording scorecard:', e.message) }
    }
    await supabase.from('siro_recordings').update({ scorecard: { none: true }, scorecard_synced_at: new Date().toISOString() }).eq('id', rec.id)
    return null
  }

  async function backfillRecordingScorecards() {
    try {
      if (!(await hasReadToken())) return
      const { data } = await supabase.from('siro_recordings').select('id, recorded_at, trade, scorecard, scorecard_synced_at')
        .gte('recorded_at', new Date(Date.now() - 7 * 86400_000).toISOString()).not('evaluation_score', 'is', null)
        .not('trade', 'is', null).is('scorecard', null).order('recorded_at', { ascending: false }).limit(25)
      for (const rec of (data || [])) await recordingScorecard(rec)
    } catch (e) { console.warn('field pro recording scorecards:', e.message) }
  }

  // ── Coaching evidence for the LT agenda ───────────────────────────────────
  // Per trade: Siro's month score, sections, lowest steps, and — once enough
  // calls carry their own scorecard — which steps go with WON calls (Siro's
  // result, synced from ServiceTitan). Per tech: score + lowest steps, keyed
  // by normalized name so the agenda can join its own tech rows.
  const TALK_GAUGE = /speaker share|pacing|words per minute/i
  async function coachingEvidence(ym = denverYm()) {
    const { data: sc } = await supabase.from('siro_tech_scorecards').select('*').eq('month', ym)
    const rows = sc || []
    const { startIso, endIso } = monthBounds(ym)
    const recs = await allRecordings(startIso, endIso, 'trade, result, evaluation_score, scorecard')
    const steps = (sections) => (sections || []).flatMap(s => (s.metrics || []).map(m => ({ step: m.name, section: s.name, score: m.points == null ? null : Math.round(m.points) })))
      .filter(m => m.score != null && !TALK_GAUGE.test(m.step))
    const byTrade = {}
    for (const t of FIELD_TRADES) {
      const team = rows.find(r => r.st_tech_id === `team:${t}`)
      const techRows = rows.filter(r => r.trade === t && !String(r.st_tech_id).startsWith('team:'))
      const tRecs = recs.filter(r => r.trade === t)
      const scored = tRecs.filter(r => r.evaluation_score != null)
      const avgOf = (list) => list.length ? Math.round(list.reduce((a, r) => a + Number(r.evaluation_score), 0) / list.length) : null
      // Step ↔ won: win rate when the step scored 50+ vs under 50, per step.
      const withSc = tRecs.filter(r => r.scorecard?.evaluated && r.result)
      const agg = new Map()
      for (const r of withSc) for (const m of steps(r.scorecard.sections)) {
        const a = agg.get(m.step) || { step: m.step, strongN: 0, strongWon: 0, weakN: 0, weakWon: 0 }
        if (m.score >= 50) { a.strongN++; if (r.result === 'WON') a.strongWon++ } else { a.weakN++; if (r.result === 'WON') a.weakWon++ }
        agg.set(m.step, a)
      }
      const stepWinLift = [...agg.values()].filter(a => a.strongN >= 5 && a.weakN >= 5)
        .map(a => ({ step: a.step, wonWhenStrong: a.strongWon / a.strongN, wonWhenWeak: a.weakWon / a.weakN, strongCalls: a.strongN, weakCalls: a.weakN }))
        .map(a => ({ ...a, lift: Math.round((a.wonWhenStrong - a.wonWhenWeak) * 100) / 100 }))
        .sort((a, b) => b.lift - a.lift).slice(0, 5)
      if (!team?.evaluated && !scored.length) continue
      byTrade[t] = {
        score: team?.evaluated ? Math.round(Number(team.points)) : avgOf(scored),
        scoredCalls: team?.evaluated || scored.length, recordedCalls: tRecs.length, wonOnCall: tRecs.filter(r => r.result === 'WON').length,
        techsRecording: techRows.filter(r => r.evaluated > 0).length, techsOnFieldPro: techRows.length,
        sections: (team?.sections || []).map(x => ({ name: x.name, weightPct: x.weight, score: x.points == null ? null : Math.round(x.points) })),
        lowestSteps: steps(team?.sections).sort((a, b) => a.score - b.score).slice(0, 5),
        strongestSteps: steps(team?.sections).sort((a, b) => b.score - a.score).slice(0, 2),
        avgScoreWonCalls: avgOf(scored.filter(r => r.result === 'WON')), avgScoreOpenCalls: avgOf(scored.filter(r => r.result !== 'WON')),
        callsWithStepScores: withSc.length, stepWinLift,
      }
    }
    const techs = {}
    for (const r of rows) {
      if (String(r.st_tech_id).startsWith('team:') || !(r.evaluated > 0)) continue
      techs[normKey(r.tech_name)] = { name: r.tech_name, trade: r.trade, score: Math.round(Number(r.points)), scoredCalls: r.evaluated,
        lowestSteps: steps(r.sections).sort((a, b) => a.score - b.score).slice(0, 3) }
    }
    const notRecording = rows.filter(r => !String(r.st_tech_id).startsWith('team:') && !(r.total > 0)).map(r => ({ name: r.tech_name, trade: r.trade }))
    return { month: ym, byTrade, techs, notRecording }
  }

  async function backfillJobInfo() {
    try {
      const { data } = await supabase.from('siro_recordings').select('id, st_job_id')
        .gte('recorded_at', new Date(Date.now() - 7 * 86400_000).toISOString()).not('st_job_id', 'is', null).is('job_number', null).limit(100)
      if (!data?.length) return
      const info = await stJobInfo(data.map(r => r.st_job_id))
      for (const r of data) {
        const j = info.get(String(r.st_job_id))
        if (!j?.jobNumber) continue
        const patch = { job_number: j.jobNumber, customer_name: j.customerName, st_customer_id: j.customerId }
        await supabase.from('siro_recordings').update(patch).eq('id', r.id)
        await supabase.from('siro_followups').update(patch).eq('recording_id', r.id).is('job_number', null)
      }
    } catch (e) { console.warn('field pro job backfill:', e.message) }
  }

  // ── Month scores for the TVs / technician scorecards ──────────────────────
  // Map stTechId → { score, calls }. Siro's own per-tech month score when the
  // read token has synced it; otherwise the average recording evaluationScore.
  async function monthScores(ym) {
    const out = new Map()
    const { data: sc } = await supabase.from('siro_tech_scorecards').select('st_tech_id, points, evaluated').eq('month', ym)
    for (const r of (sc || [])) {
      if (String(r.st_tech_id).startsWith('team:')) continue
      if (r.evaluated > 0 && r.points != null) out.set(String(r.st_tech_id), { score: Math.round(Number(r.points)), calls: r.evaluated })
    }
    const { startIso, endIso } = monthBounds(ym)
    const recs = await allRecordings(startIso, endIso, 'st_tech_id, evaluation_score')
    const agg = new Map()
    for (const r of recs) {
      if (!r.st_tech_id || r.evaluation_score == null) continue
      const a = agg.get(r.st_tech_id) || { sum: 0, n: 0 }
      a.sum += Number(r.evaluation_score); a.n++; agg.set(r.st_tech_id, a)
    }
    for (const [id, a] of agg) if (!out.has(id)) out.set(id, { score: Math.round(a.sum / a.n), calls: a.n })
    // "Tracked" = Field Pro has data for this month at all; a tech with none
    // then scores 0 rather than being left out.
    out.tracked = recs.length > 0 || (sc || []).some(r => r.evaluated > 0)
    return out
  }
  async function allRecordings(startIso, endIso, cols) {
    const out = []
    for (let from = 0; from < 50_000; from += 1000) {
      const { data, error } = await supabase.from('siro_recordings').select(cols)
        .gte('recorded_at', startIso).lt('recorded_at', endIso).order('recorded_at', { ascending: false }).range(from, from + 999)
      if (error || !data) break
      out.push(...data)
      if (data.length < 1000) break
    }
    return out
  }

  // ── Re-Engage morning roundup ─────────────────────────────────────────────
  // One email per person at 7 AM Denver (Brandyn, Sep 26: "one morning
  // roundup per person"), covering leads Field Pro flagged since the last
  // roundup: owners (reengage_emails.to) get every lead, each operations
  // manager their trade(s) (Cedric: Electrical + Garage in one email), each
  // tech their own — with Siro's ready-to-send text and email, which only the
  // tech's copy carries. Replica-safe: a compare-and-set day claim, like the
  // 7 AM digest. A lead is marked sent once any recipient got it; a lead no
  // one got stays pending for tomorrow's roundup.
  async function emailConfig() {
    const [{ data: c }, { data: m }] = await Promise.all([
      supabase.from('app_settings').select('value').eq('key', 'reengage_emails').maybeSingle(),
      supabase.from('app_settings').select('value').eq('key', 'field_ops_managers').maybeSingle(),
    ])
    let cfg = {}, mgrs = {}
    try { cfg = JSON.parse(c?.value || '{}') } catch {}
    try { mgrs = JSON.parse(m?.value || '{}') } catch {}
    return { cfg: { enabled: false, minScore: 3, hour: 7, to: [], ...cfg }, mgrs }
  }
  const firstNameOf = (email) => { const s = String(email || '').split('@')[0].split(/[._-]/)[0]; return s ? s[0].toUpperCase() + s.slice(1) : '' }

  // Pending leads → { email: { name, role, trades:Set, leads:[f], drafts:Set(lead ids) } }
  async function roundupPeople(leads, cfg, mgrs) {
    const users = await siroUsers()
    const people = new Map()
    const add = (email, name, role, f, withDrafts, trade) => {
      if (!email) return
      const k = String(email).trim().toLowerCase()
      const p = people.get(k) || { email: k, name, role, trades: new Set(), leads: new Map(), drafts: new Set() }
      // A person can wear two hats (a manager who records); the broadest wins.
      const rank = { owner: 3, manager: 2, tech: 1 }
      if (rank[role] > rank[p.role]) { p.role = role; p.name = name || p.name }
      if (trade) p.trades.add(trade)
      p.leads.set(f.id, f)
      if (withDrafts) p.drafts.add(f.id)
      people.set(k, p)
    }
    for (const f of leads) {
      for (const e of (cfg.to || [])) add(e, firstNameOf(e), 'owner', f, false)
      const m = f.trade ? mgrs[f.trade] : null
      if (m?.email) add(m.email, m.name, 'manager', f, false, f.trade)
      const t = users.get(f.siro_user_id)
      if (t?.email) add(t.email, f.tech_name || t.name, 'tech', f, true)
    }
    return [...people.values()].map(p => ({ ...p, leads: [...p.leads.values()].sort((a, b) => (b.score - a.score) || String(a.created_at).localeCompare(String(b.created_at))) }))
  }

  const TYPE_LABEL = { REHASH: 'Rehash — unsold quote', CROSS_SELL: 'Cross-sell opportunity' }
  const leadCost = (f) => Number(String(f.context?.overall_cost || '').replace(/[^0-9.]/g, '')) || 0
  const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`
  const RC = { ink: '#0F172A', mute: '#64748B', line: '#E2E8F0', soft: '#F8FAFC', accent: '#ff751f', good: '#15803D', warn: '#B45309', bad: '#B91C1C' }

  function leadCard(f, rec, { drafts, showTech }) {
    const c = f.context || {}
    const C = RC
    const first = String(f.tech_name || 'the tech').split(/\s+/)[0]
    const cost = leadCost(f)
    const when = f.created_at ? new Date(f.created_at).toLocaleString('en-US', { timeZone: DENVER, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
    const chip = (text, bg, fg) => `<span style="display:inline-block;font-size:11px;font-weight:700;border-radius:99px;padding:2px 9px;margin:0 5px 5px 0;background:${bg};color:${fg}">${esc(text)}</span>`
    const block = (title, body, box) => body ? `
      <div style="margin-top:12px">
        <div style="font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:${C.mute};margin-bottom:4px">${esc(title)}</div>
        <div style="font-size:13.5px;line-height:1.55;color:${C.ink};white-space:pre-wrap;${box ? `background:${C.soft};border:1px solid ${C.line};border-radius:9px;padding:10px 12px;` : ''}">${esc(String(body).replace(/\*\*(.+?)\*\*/g, '$1'))}</div>
      </div>` : ''
    const objections = [c.main_objection, c.secondary_objection].filter(x => x && !/^(none|n\/?a)$/i.test(String(x).trim())).join(' · also ')
    const stUrl = f.st_job_id ? `https://go.servicetitan.com/#/Job/Index/${f.st_job_id}` : null
    const link = (href, label) => href ? `<a href="${esc(href)}" style="color:${C.accent};font-weight:700;text-decoration:none;margin-right:16px">${esc(label)} →</a>` : ''
    return `
    <div style="border:1px solid ${C.line};border-radius:12px;padding:14px 16px;margin-top:14px">
      <div style="font-size:16px;font-weight:800">${esc(f.customer_name || 'Customer')}${f.job_number ? ` <span style="font-size:12.5px;font-weight:600;color:${C.mute}">· Job #${esc(f.job_number)}</span>` : ''}</div>
      <div style="font-size:12.5px;color:${C.mute};margin:2px 0 8px">${esc([showTech ? f.tech_name : null, f.trade, when].filter(Boolean).join(' · '))}</div>
      <div>
        ${chip(`Priority ${f.score ?? '—'} of 5`, f.score >= 4 ? '#FEE2E2' : '#FEF3C7', f.score >= 4 ? C.bad : C.warn)}
        ${chip(TYPE_LABEL[f.followup_type] || 'Follow-up', '#E0F2FE', '#075985')}
        ${cost > 0 ? chip(`Quoted ${usd(cost)}`, '#DCFCE7', C.good) : ''}
        ${c.follow_up_time ? chip(`When: ${c.follow_up_time}`, '#F1F5F9', C.ink) : ''}
      </div>
      ${block('Best way to follow up', c.follow_up_summary, true)}
      ${block('What was quoted', drafts ? [c.scope_cost_summary, c.pricing_options].filter(Boolean).join('\n\n') : c.scope_cost_summary)}
      ${block('Why it didn’t close', [c.objection_summary, objections ? `Main objection: ${objections}` : ''].filter(Boolean).join('\n'))}
      ${drafts ? block('Financing offered', c.financing) : ''}
      ${drafts ? block(`Ready-to-send text (from ${first})`, c.FollowupTextHeader, true) : ''}
      ${drafts ? block(`Ready-to-send email (from ${first})`, c.FollowupEmailHeader, true) : ''}
      <div style="margin-top:12px;font-size:13px">${link(stUrl, 'Open the job in ServiceTitan')}${link(rec?.web_url, 'Listen in Field Pro')}</div>
    </div>`
  }

  function roundupEmail(person, recById, dateLabel) {
    const C = RC
    const leads = person.leads
    const quoted = leads.reduce((a, f) => a + leadCost(f), 0)
    const hi = leads.filter(f => f.score >= 4).length
    const n = leads.length
    const isTech = person.role === 'tech'
    const scope = person.role === 'manager' ? [...person.trades].join(' + ') : ''
    const title = isTech ? `Your ${n} lead${n === 1 ? '' : 's'} to follow up today` : `${n} lead${n === 1 ? '' : 's'} to follow up today${scope ? ` · ${scope}` : ''}`
    const summary = [quoted ? `${usd(quoted)} quoted` : null, hi ? `${hi} high priority` : null].filter(Boolean).join(' · ')
    // Owners and managers get an at-a-glance list before the detail.
    const table = !isTech && n > 1 ? `
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:14px">
        <tr>${['Customer', 'Tech', 'Priority', 'Quoted', 'When'].map((h, i) => `<th style="text-align:${i >= 2 ? 'right' : 'left'};padding:5px 6px;border-bottom:1px solid ${C.line};font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:${C.mute}">${h}</th>`).join('')}</tr>
        ${leads.map(f => `<tr>
          <td style="padding:6px;border-bottom:1px solid ${C.line};font-weight:600">${esc(f.customer_name || 'Customer')}</td>
          <td style="padding:6px;border-bottom:1px solid ${C.line}">${esc(f.tech_name || '—')}</td>
          <td style="padding:6px;border-bottom:1px solid ${C.line};text-align:right;color:${f.score >= 4 ? C.bad : C.warn};font-weight:700">${f.score ?? '—'}/5</td>
          <td style="padding:6px;border-bottom:1px solid ${C.line};text-align:right">${leadCost(f) ? usd(leadCost(f)) : '—'}</td>
          <td style="padding:6px;border-bottom:1px solid ${C.line};text-align:right">${esc(f.context?.follow_up_time || '—')}</td>
        </tr>`).join('')}
      </table>` : ''
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:660px;margin:0 auto;color:${C.ink};padding:8px">
      <div style="font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:${C.accent}">Re-Engage · Field Pro · ${esc(dateLabel)}</div>
      <div style="font-size:21px;font-weight:800;margin:4px 0 2px">${esc(title)}</div>
      <div style="font-size:13px;color:${C.mute}">${person.name ? `Good morning, ${esc(String(person.name).split(/\s+/)[0])}. ` : ''}${isTech ? 'Customers from your in-home calls who didn’t buy yet — each with the best way to follow up.' : 'Customers from the team’s in-home calls who didn’t buy yet.'}${summary ? ` ${esc(summary)}.` : ''}</div>
      ${table}
      ${leads.map(f => leadCard(f, recById.get(f.recording_id), { drafts: person.drafts.has(f.id), showTech: !isTech })).join('')}
      <div style="margin-top:18px;padding-top:12px;border-top:1px solid ${C.line};font-size:11.5px;color:${C.mute};line-height:1.6">
        Field Pro flags these from recorded in-home calls. ${isTech ? 'The drafts are Siro’s suggestion — read before sending. ' : ''}When a lead is handled, mark it done in Field Pro → Re-Engage.
        ${isTech ? '' : 'Techs get their own leads with ready-to-send texts and emails; operations managers get their trade’s.'}
      </div>
    </div>`
    const subject = isTech
      ? `Re-Engage: your ${n} lead${n === 1 ? '' : 's'} to follow up today${quoted ? ` (${usd(quoted)} quoted)` : ''}`
      : `Re-Engage${scope ? ` ${scope}` : ''}: ${n} lead${n === 1 ? '' : 's'} to follow up today${quoted ? ` (${usd(quoted)} quoted)` : ''}`
    return { subject, html }
  }

  async function pendingLeads(cfg) {
    // Never the backlog: only follow-ups from `since` (default: switch-on time).
    const since = cfg.since || cfg.startAt
    if (!since) return []
    const { data } = await supabase.from('siro_followups').select('*').is('emailed_at', null).eq('status', 'TO_DO')
      .gte('score', Number(cfg.minScore) || 3).gte('created_at', since).order('created_at', { ascending: true }).limit(200)
    return data || []
  }
  const dayLabelOf = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })

  // Admin preview: what each person's roundup would look like right now.
  async function previewRoundup(email) {
    const { cfg, mgrs } = await emailConfig()
    let leads = await pendingLeads(cfg)
    if (!leads.length) {   // nothing pending → show the latest leads so the format is visible
      const { data } = await supabase.from('siro_followups').select('*').gte('score', Number(cfg.minScore) || 3).order('created_at', { ascending: false }).limit(6)
      leads = data || []
    }
    const people = await roundupPeople(leads, cfg, mgrs)
    const person = people.find(p => p.email === String(email || '').toLowerCase()) || people.find(p => p.role === 'owner') || people[0]
    if (!person) return null
    const { data: recs } = await supabase.from('siro_recordings').select('id, web_url').in('id', [...new Set(person.leads.map(f => f.recording_id))])
    return { people: people.map(p => ({ email: p.email, name: p.name, role: p.role, leads: p.leads.length })), to: person.email, ...roundupEmail(person, new Map((recs || []).map(r => [r.id, r])), dayLabelOf(denverYmd())) }
  }

  const ROUNDUP_SENT_KEY = 'reengage_roundup_sent_on'
  let _mailBusy = false
  async function sendReengageRoundup() {
    if (_mailBusy || !sendResend) return null
    _mailBusy = true
    try {
      const { cfg, mgrs } = await emailConfig()
      if (!cfg.enabled) return { skipped: 'disabled' }
      if (cfg.startAt && Date.now() < Date.parse(cfg.startAt)) return { skipped: 'before start' }
      const hour = Number(cfg.hour ?? 7)
      const h = denverHour()
      if (h < hour || h >= hour + 3) return { skipped: 'outside the morning window' }
      const today = denverYmd()
      const { data: row } = await supabase.from('app_settings').select('value').eq('key', ROUNDUP_SENT_KEY).maybeSingle()
      const prev = row?.value ?? null
      if (String(prev).replace(/"/g, '') === today) return { skipped: 'already sent today' }
      const leads = await pendingLeads(cfg)
      if (!leads.length) return { sent: 0 }
      // Replica-safe day claim (compare-and-set), same as the 7 AM digest.
      if (row) {
        const { data: claimed } = await supabase.from('app_settings').update({ value: today }).eq('key', ROUNDUP_SENT_KEY).eq('value', prev).select()
        if (!claimed?.length) return { skipped: 'claimed by another server' }
      } else {
        const { error } = await supabase.from('app_settings').insert({ key: ROUNDUP_SENT_KEY, value: today })
        if (error) return { skipped: 'claimed by another server' }
      }
      const people = await roundupPeople(leads, cfg, mgrs)
      const { data: recs } = await supabase.from('siro_recordings').select('id, web_url').in('id', [...new Set(leads.map(f => f.recording_id))])
      const recById = new Map((recs || []).map(r => [r.id, r]))
      const label = dayLabelOf(today)
      const got = new Map(leads.map(f => [f.id, []]))
      const failed = new Map(leads.map(f => [f.id, []]))
      let sent = 0
      for (const p of people) {
        const { subject, html } = roundupEmail(p, recById, label)
        let ok = false
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try { await sendResend({ to: [p.email], subject, html }); ok = true }
          catch (e) { if (attempt) console.warn(`re-engage roundup to ${p.email}:`, e.message); else await sleep(4000) }
        }
        if (ok) sent++
        for (const f of p.leads) (ok ? got : failed).get(f.id).push(p.email)
      }
      const now = new Date().toISOString()
      for (const f of leads) {
        const to = got.get(f.id), bad = failed.get(f.id)
        if (!to.length) continue   // nobody got it → stays pending for tomorrow
        await supabase.from('siro_followups').update({ emailed_at: now, email_to: to, email_error: bad.length ? `not delivered to ${bad.join(', ')}` : null }).eq('id', f.id)
      }
      console.log(`field pro: Re-Engage roundup — ${leads.length} lead(s) to ${sent}/${people.length} people`)
      return { leads: leads.length, sent, people: people.length }
    } catch (e) {
      console.warn('re-engage roundup:', e.message)
      return { error: e.message }
    } finally { _mailBusy = false }
  }

  // ── Coaching snapshot (Team → Technicians → Coaching & Evals) ─────────────
  const normKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const _aiInflight = new Set()   // one AI write-up per month at a time
  async function coaching(ym, { refresh = false } = {}) {
    const prev = shiftYm(ym, -1)
    const [{ data: cur }, { data: prv }] = await Promise.all([
      supabase.from('siro_tech_scorecards').select('*').eq('month', ym),
      supabase.from('siro_tech_scorecards').select('st_tech_id, points, evaluated').eq('month', prev),
    ])
    const { startIso, endIso } = monthBounds(ym)
    const recs = await allRecordings(startIso, endIso, 'id, st_tech_id, tech_name, trade, recorded_at, evaluation_score, result, summary')
    const prevBy = new Map((prv || []).map(r => [String(r.st_tech_id), r]))
    const recsBy = new Map()
    for (const r of recs) { if (!r.st_tech_id) continue; if (!recsBy.has(r.st_tech_id)) recsBy.set(r.st_tech_id, []); recsBy.get(r.st_tech_id).push(r) }
    const dayOf = (iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: DENVER, day: 'numeric' }).format(new Date(iso)))
    const weekly = (list) => {
      const w = []
      for (const r of list) {
        if (r.evaluation_score == null) continue
        const i = Math.min(4, Math.floor((dayOf(r.recorded_at) - 1) / 7))
        w[i] = w[i] || { s: 0, n: 0 }; w[i].s += Number(r.evaluation_score); w[i].n++
      }
      return w.map(x => (x ? Math.round(x.s / x.n) : null))
    }
    const meta = await techMeta()
    const rowsCur = (cur || []).filter(r => !String(r.st_tech_id).startsWith('team:'))
    const teamRows = (cur || []).filter(r => String(r.st_tech_id).startsWith('team:'))
    // Techs with a Siro scorecard row, plus anyone with recordings but no row
    // (read token down) — those fall back to their recordings' average.
    const cardsBase = []
    const seen = new Set()
    for (const r of rowsCur) {
      if (!(r.evaluated > 0)) continue
      seen.add(String(r.st_tech_id))
      cardsBase.push({ id: String(r.st_tech_id), name: r.tech_name, trade: r.trade, points: Math.round(Number(r.points)), evaluated: r.evaluated, total: r.total, won: r.won, sections: r.sections || [] })
    }
    for (const [id, list] of recsBy) {
      if (seen.has(id)) continue
      const scored = list.filter(r => r.evaluation_score != null)
      if (!scored.length) continue
      const m = meta.get(id)
      if (m && !(m.roster || m.install)) continue
      cardsBase.push({ id, name: list[0].tech_name || m?.name || 'Unknown', trade: list[0].trade || m?.trade || null,
        points: Math.round(scored.reduce((a, r) => a + Number(r.evaluation_score), 0) / scored.length),
        evaluated: scored.length, total: list.length, won: list.filter(r => r.result === 'WON').length, sections: [] })
    }
    const metricsOf = (sections) => sections.flatMap(s => (s.metrics || []).map(m => ({ ...m, section: s.name })))
      .filter(m => m.points != null && !/speaker share|pacing|words per minute/i.test(m.name))   // talk-ratio gauges aren't coachable "misses"
    const cardsCore = cardsBase.map(c => {
      const metrics = metricsOf(c.sections)
      const p = prevBy.get(c.id)
      const list = recsBy.get(c.id) || []
      return {
        id: c.id, name: c.name, trade: c.trade,
        qa: c.points, prevQa: p?.evaluated > 0 && p.points != null ? Math.round(Number(p.points)) : null,
        evals: c.evaluated, recordings: c.total, won: c.won,
        trend: weekly(list),
        sections: c.sections.map(s => ({ name: s.name, weight: s.weight, rate: s.points == null ? null : Math.round(s.points) })).filter(s => s.rate != null),
        gaps: [...metrics].sort((a, b) => a.points - b.points).slice(0, 3).map(m => ({ criterion: m.name, section: m.section, score: Math.round(m.points) })),
        _weakest: [...metrics].sort((a, b) => a.points - b.points).slice(0, 5).map(m => ({ step: m.name, section: m.section, score: Math.round(m.points) })),
        _strongest: [...metrics].sort((a, b) => b.points - a.points).slice(0, 3).map(m => ({ step: m.name, score: Math.round(m.points) })),
        _siro: list.slice(0, 4).flatMap(r => (r.summary || []).filter(s => /^(strength|growth area)$/i.test(s.name)).map(s => `${s.name}: ${String(s.content || '').slice(0, 280)}`)).slice(0, 6),
      }
    }).sort((a, b) => b.qa - a.qa)

    // Team rollups: each trade from Siro's org-level row; "all" weights the
    // trades by how many recordings were scored.
    const teamOf = (trades) => {
      const tr = teamRows.filter(r => trades.includes(r.trade) && r.evaluated > 0)
      const cards = cardsCore.filter(c => trades.includes(c.trade))
      const n = tr.reduce((a, r) => a + r.evaluated, 0)
      const wavg = (get) => { let s = 0, w = 0; for (const r of tr) { const v = get(r); if (v != null) { s += v * r.evaluated; w += r.evaluated } } return w ? Math.round(s / w) : null }
      const secNames = [...new Set(tr.flatMap(r => (r.sections || []).map(s => s.name)))]
      const sections = secNames.map(name => ({ name, rate: wavg(r => (r.sections || []).find(s => s.name === name)?.points ?? null) })).filter(s => s.rate != null)
      const metricAgg = new Map()
      for (const r of tr) for (const m of metricsOf(r.sections || [])) {
        const k = normKey(m.name)
        const a = metricAgg.get(k) || { criterion: m.name, section: m.section, s: 0, w: 0 }
        a.s += m.points * r.evaluated; a.w += r.evaluated; metricAgg.set(k, a)
      }
      const focus = [...metricAgg.values()].map(a => ({ criterion: a.criterion, section: a.section, score: Math.round(a.s / a.w),
        csrs: cards.filter(c => c.gaps.some(g => normKey(g.criterion) === normKey(a.criterion))).length }))
        .sort((a, b) => a.score - b.score).slice(0, 4)
      // No org rows (read token down): fall back to the cards themselves.
      const cardAvg = cards.length ? Math.round(cards.reduce((a, c) => a + c.qa * c.evals, 0) / Math.max(1, cards.reduce((a, c) => a + c.evals, 0))) : null
      const prevTeam = (prv || []).filter(r => String(r.st_tech_id).startsWith('team:') && trades.includes(String(r.st_tech_id).slice(5)) && r.evaluated > 0)
      const pn = prevTeam.reduce((a, r) => a + r.evaluated, 0)
      return {
        qa: tr.length ? wavg(r => (r.points == null ? null : Number(r.points))) : cardAvg,
        prevQa: pn ? Math.round(prevTeam.reduce((a, r) => a + Number(r.points) * r.evaluated, 0) / pn) : null,
        prevMonth: prev, evals: n || cards.reduce((a, c) => a + c.evals, 0), csrs: cards.length, sections, focus,
      }
    }
    const teams = { all: teamOf(FIELD_TRADES) }
    for (const t of FIELD_TRADES) teams[t] = teamOf([t])

    // AI coach notes — cached; regenerated when the month's scored volume
    // moved 10%+, a tech has no notes yet, 12h+ old on the current month, or
    // a manager hits Regenerate. A bad AI minute never blanks a card.
    const cacheKey = `tech_coaching_${ym}`
    let cached = null
    try { const { data: c } = await supabase.from('app_settings').select('value').eq('key', cacheKey).maybeSingle(); cached = c?.value ? JSON.parse(c.value) : null } catch {}
    const prevText = new Map((cached?.cards || []).filter(c => c.drill).map(c => [String(c.id), c]))
    const evalCount = cardsCore.reduce((a, c) => a + c.evals, 0)
    const ageH = cached?.generatedAt ? (Date.now() - Date.parse(cached.generatedAt)) / 36e5 : Infinity
    const moved = cached ? Math.abs(evalCount - (cached.evalCount || 0)) / Math.max(1, cached.evalCount || 0) : 1
    // Volume/new-tech triggers wait an hour between runs — recordings stream
    // in all day, and a tech the model skipped mustn't re-run it every view.
    const needAi = refresh || !cached
      || (ageH >= 1 && (moved >= 0.10 || cardsCore.some(c => !prevText.has(c.id))))
      || (ym === denverYm() && ageH >= 12)
    const coached = new Map()
    let generatedAt = cached?.generatedAt || null
    if (needAi && anthropicKey && cardsCore.length && !_aiInflight.has(ym)) {
      _aiInflight.add(ym)
      const aiInput = cardsCore.map(c => ({ id: c.id, name: c.name, trade: c.trade, score: c.qa, recordingsScored: c.evals, wonOnTheCall: c.won, sections: c.sections, weakestSteps: c._weakest, strongestSteps: c._strongest, siroNotes: c._siro }))
      for (let attempt = 0; attempt < 2 && !coached.size; attempt++) {
        try {
          if (attempt) await sleep(2500)
          const r = await withTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-5', max_tokens: 12000,
              system: 'You write monthly coaching snapshots for in-home field technicians (HVAC, plumbing, electrical, garage doors) at a home-services company, addressed to their operations managers. Ground every point ONLY in the data given: Siro Field Pro scorecard results (0-100 per step; 80+ strong, 50-79 developing, under 50 a gap) and Siro\'s own Strength / Growth Area notes from their recent calls. For EVERY tech in the list, using the id and name EXACTLY as given: 1-2 "working" points naming strong behaviors with their scores, 1-2 "coach" points naming the exact step and its score (e.g. "Price Presentation scored 23 of 100 across 6 recorded calls"), and ONE specific drill for the next ride-along or 1:1 that practices that step in the customer\'s home. Coach the behavior, never the person. Fewer than 3 scored recordings = say the sample is thin and keep it light. Plain language a tech would use; no jargon about scorecards.',
              tools: [{
                name: 'submit_snapshots', description: 'Submit coaching snapshots',
                input_schema: { type: 'object', properties: { techs: { type: 'array', items: { type: 'object', properties: {
                  id: { type: 'string' }, name: { type: 'string' },
                  working: { type: 'array', items: { type: 'string' } },
                  coach: { type: 'array', items: { type: 'string' } },
                  drill: { type: 'string', description: 'One concrete exercise for the next ride-along or 1:1' },
                }, required: ['id', 'name', 'working', 'coach', 'drill'] } } }, required: ['techs'] },
              }],
              tool_choice: { type: 'tool', name: 'submit_snapshots' },
              messages: [{ role: 'user', content: `Month: ${ym}. Per-tech Field Pro results:\n${JSON.stringify(aiInput)}` }],
            }),
          }, 150_000)
          const body = await r.json()
          if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body?.error || body).slice(0, 200)}`)
          const out = body?.content?.find(c => c.type === 'tool_use')?.input
          for (const t of (out?.techs || [])) if (t?.id) coached.set(String(t.id), t)
          if (!coached.size) throw new Error('no snapshots in the response')
          generatedAt = new Date().toISOString()
        } catch (e) { console.warn(`tech coaching ai (attempt ${attempt + 1}):`, e.message) }
      }
      _aiInflight.delete(ym)
    }
    const cards = cardsCore.map(({ _weakest, _strongest, _siro, ...c }) => {
      const t = coached.get(c.id) || prevText.get(c.id) || {}
      return { ...c, working: t.working || [], coach: t.coach || [], drill: t.drill || '' }
    })
    if (coached.size) {
      try {
        await supabase.from('app_settings').upsert({ key: cacheKey, value: JSON.stringify({
          month: ym, evalCount, generatedAt, cards: cards.map(({ id, name, working, coach, drill }) => ({ id, name, working, coach, drill })),
        }) }, { onConflict: 'key' })
      } catch {}
    }
    const { data: st } = await supabase.from('sync_state').select('last_synced_at').eq('key', 'siro_recordings').maybeSingle()
    return { month: ym, generatedAt: generatedAt || new Date().toISOString(), syncedAt: st?.last_synced_at || null, scorecards: rowsCur.length > 0, teams, cards }
  }

  // ── 7 AM digest facts for one Denver day ──────────────────────────────────
  async function digestFacts(dateStr, technicians = []) {
    const startIso = denverMidnightIso(dateStr)
    const next = new Date(`${dateStr}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1)
    const endIso = denverMidnightIso(next.toISOString().slice(0, 10))
    const recs = await allRecordings(startIso, endIso, 'id, st_tech_id, tech_name, trade, evaluation_score, result, duration_sec, summary')
    const { data: fus } = await supabase.from('siro_followups').select('id, score, status, context, tech_name, trade, created_at')
      .gte('created_at', startIso).lt('created_at', endIso)
    const ym = dateStr.slice(0, 7)
    const { data: sc } = await supabase.from('siro_tech_scorecards').select('*').eq('month', ym)
    const meta = await techMeta()
    const by = new Map()
    for (const r of recs) {
      const k = r.st_tech_id || `n:${r.tech_name}`
      const a = by.get(k) || { id: r.st_tech_id, name: r.tech_name || 'Unknown', trade: r.trade, recordings: 0, scored: 0, sum: 0, won: 0, growth: [] }
      a.recordings++
      if (r.evaluation_score != null) { a.scored++; a.sum += Number(r.evaluation_score) }
      if (r.result === 'WON') a.won++
      const g = (r.summary || []).find(s => /^growth area$/i.test(s.name))
      if (g && a.growth.length < 2) a.growth.push(String(g.content || '').slice(0, 220))
      by.set(k, a)
    }
    const scByTech = new Map((sc || []).map(r => [String(r.st_tech_id), r]))
    const jobsById = new Map(technicians.filter(t => t.id).map(t => [String(t.id), t]))
    const byTech = [...by.values()].map(a => {
      const m = scByTech.get(String(a.id))
      const weakest = (m?.sections || []).flatMap(s => (s.metrics || []).map(x => ({ step: String(x.name || '').trim(), score: x.points })))
        .filter(x => x.score != null && !/speaker share|pacing/i.test(x.step)).sort((x, y) => x.score - y.score).slice(0, 3)
      return {
        name: a.name, trade: a.trade, recordings: a.recordings, avgScore: a.scored ? Math.round(a.sum / a.scored) : null, won: a.won,
        jobsRan: jobsById.get(String(a.id))?.jobsRan ?? null,
        monthScore: m?.evaluated > 0 && m.points != null ? Math.round(Number(m.points)) : null,
        monthWeakestSteps: weakest, siroGrowthNotes: a.growth,
      }
    }).sort((x, y) => (y.avgScore ?? -1) - (x.avgScore ?? -1))
    const recorded = new Set([...by.values()].map(a => String(a.id)))
    const notRecording = technicians.filter(t => t.id && t.jobsRan > 0 && !recorded.has(String(t.id)) && meta.get(String(t.id))?.roster)
      .map(t => ({ name: t.name, jobsRan: t.jobsRan })).sort((a, b) => b.jobsRan - a.jobsRan)
    const scored = recs.filter(r => r.evaluation_score != null)
    const newFu = (fus || []).filter(f => (f.score ?? 0) >= 3)
    const quoted = newFu.reduce((a, f) => a + (Number(String(f.context?.overall_cost || '').replace(/[^0-9.]/g, '')) || 0), 0)
    const monthByTrade = FIELD_TRADES.map(t => {
      const r = (sc || []).find(x => x.st_tech_id === `team:${t}`)
      return { trade: t, score: r?.evaluated > 0 && r.points != null ? Math.round(Number(r.points)) : null, scored: r?.evaluated || 0 }
    })
    if (!recs.length && !(fus || []).length && !(sc || []).length) return null
    return {
      recordings: recs.length, scored: scored.length, techs: by.size,
      avgScore: scored.length ? Math.round(scored.reduce((a, r) => a + Number(r.evaluation_score), 0) / scored.length) : null,
      wonOnCall: recs.filter(r => r.result === 'WON').length,
      reengage: { new: newFu.length, quoted: Math.round(quoted), highPriority: newFu.filter(f => f.score >= 4).length },
      byTech, notRecording, monthByTrade,
    }
  }

  return {
    syncRecordings, refreshFollowupStatuses, syncTechScorecards, sendReengageRoundup, previewRoundup, monthScores, coaching, digestFacts, coachingEvidence,
    recordingScorecard, hasReadToken, siroUsers,
  }
}
