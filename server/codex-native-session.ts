import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import {parseCodexNativeRecords, type NativeConversationRecord} from '../src/lib/providers/codex-native'
import type {SessionData} from '../src/types/session'
/** Read one selected native projection, never enumerate other threads. */
export function readCodexNativeSession(home:string,sessionId:string):SessionData|null {
  if(!/^[0-9a-f-]{36}$/.test(sessionId))throw new Error('Invalid session identity')
  const file=path.join(home,'.codex','thread_history_1.sqlite')
  if(!fs.existsSync(file))return null
  const db=new Database(file,{readonly:true,fileMustExist:true})
  try {
    db.pragma('query_only = ON')
    return db.transaction(()=>{
      const cursor=db.prepare('SELECT next_rollout_ordinal FROM thread_history_projection_state WHERE thread_id=?').get(sessionId)
      if(!cursor)return null
      const rows=db.prepare('SELECT rollout_ordinal,created_at_ms,item_id,item_json FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal,item_id').all(sessionId) as {rollout_ordinal:number;created_at_ms:number|null;item_id:string;item_json:string}[]
      const records:NativeConversationRecord[]=rows.map(row=>({id:row.item_id,ordinal:row.rollout_ordinal,timestamp:row.created_at_ms==null ? null : new Date(row.created_at_ms).toISOString(),item:JSON.parse(row.item_json)}))
      return parseCodexNativeRecords(records)
    })()
  } finally {db.close()}
}
