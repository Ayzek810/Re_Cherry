import { createClient } from '@libsql/client'
const db = createClient({ url: 'file:C:/Users/Asimov/AppData/Roaming/Re_CherryDev/kernel/sessions.db' })
const latest = (await db.execute('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1')).rows[0]
const rows = await db.execute({
  sql: "SELECT seq, time, type, data FROM events WHERE session_id = ? AND type IN ('text-chunks','reasoning-chunks') ORDER BY seq",
  args: [String(latest.id)]
})
for (const row of rows.rows) {
  const data = JSON.parse(String(row.data))
  const dts = (data.dt ?? []).reduce((acc, gap, i) => { acc.push((acc[i - 1] ?? 0) + gap); return acc }, [])
  const kind = String(row.type).replace('-chunks', '')
  console.log(kind, 't0=' + String(row.time), 'offsets(ms):', JSON.stringify(dts))
}