import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {it,expect} from 'vitest'
import {readCodexNativeSession} from './codex-native-session'
it('reads only the selected projected thread and keeps no-projection distinct from empty',()=>{
  const home=mkdtempSync(path.join(tmpdir(),'cfv-native-')),sid='00000000-0000-4000-8000-000000000001'
  try {
    mkdirSync(path.join(home,'.codex'))
    const db=new Database(path.join(home,'.codex/thread_history_1.sqlite'))
    db.exec('CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_ordinal INTEGER);CREATE TABLE thread_items(thread_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_id TEXT,item_json TEXT)')
    db.prepare('INSERT INTO thread_history_projection_state VALUES(?,?)').run(sid,2)
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run(sid,1,1000,'a',JSON.stringify({type:'agentMessage',text:'selected only'}))
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run('another',1,1000,'b',JSON.stringify({type:'agentMessage',text:'unselected'}));db.close()
    expect(readCodexNativeSession(home,sid)?.messages).toHaveLength(1)
    expect(readCodexNativeSession(home,'00000000-0000-4000-8000-000000000002')).toBeNull()
  } finally {rmSync(home,{recursive:true,force:true})}
})
