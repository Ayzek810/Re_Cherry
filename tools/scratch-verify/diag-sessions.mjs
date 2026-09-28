/** 诊断（只读）：DEV 库（Re_CherryDev）——列最近会话 + 捞含 "Attached documents" 的事件全文。 */
import { createClient } from '@libsql/client'

const dbPath = 'C:/Users/Asimov/AppData/Roaming/Re_CherryDev/kernel/sessions.db'
const db = createClient({ url: `file:///${dbPath.replace(/\\/g, '/')}` })

const sess = await db.execute('SELECT id, created_at, seed_length FROM sessions ORDER BY created_at DESC LIMIT 10')
for (const row of sess.rows) {
  const created = new Date(Number(row.created_at)).toISOString()
  console.log(`session ${row.id} created=${created} seed=${row.seed_length}`)
}

const hit = await db.execute({
  sql: "SELECT session_id, seq, type, data FROM events WHERE data LIKE '%Attached documents%' ORDER BY seq DESC LIMIT 2"
})
console.log(`\nhits: ${hit.rows.length}`)
for (const row of hit.rows) {
  console.log(`\n===== session=${row.session_id} seq=${row.seq} type=${row.type} =====`)
  const data = JSON.parse(String(row.data))
  const text = JSON.stringify(data, null, 1)
  console.log(text.length > 9000 ? `${text.slice(0, 9000)}…(${text.length})` : text)
}
process.exit(0)
