import type { Db } from '../db/pool.js';
import { HttpError } from '../http/http.js';

export interface Message { id: string; role: 'user' | 'assistant'; content: string; card_ids: string[]; created_at: string }
export interface Conversation { id: string; title: string; created_at: string; updated_at: string }

export async function getOrCreateConversation(db: Db, userId: string, id: string | null, firstMessage: string): Promise<Conversation> {
  if (id) {
    const r = await db.query<Conversation>('select id, title, created_at, updated_at from conversations where id = $1 and user_id = $2', [id, userId]);
    if (!r.rows[0]) throw new HttpError(404, 'La conversación no existe.');
    return r.rows[0];
  }
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Conversación';
  return (await db.query<Conversation>('insert into conversations (user_id, title) values ($1, $2) returning id, title, created_at, updated_at', [userId, title])).rows[0]!;
}

export async function addMessage(db: Db, userId: string, conversationId: string, role: 'user' | 'assistant', content: string, cardIds: string[] = []): Promise<Message> {
  const r = await db.query<Message>(
    'insert into messages (conversation_id, user_id, role, content, card_ids) values ($1, $2, $3, $4, $5) returning id, role, content, card_ids, created_at',
    [conversationId, userId, role, content.slice(0, 20000), cardIds]);
  await db.query('update conversations set updated_at = now() where id = $1', [conversationId]);
  return r.rows[0]!;
}

export async function listMessages(db: Db, userId: string, conversationId: string, limit = 100): Promise<Message[]> {
  const r = await db.query<Message>(
    `select * from (select id, role, content, card_ids, created_at from messages where conversation_id = $1 and user_id = $2 order by created_at desc limit $3) m order by created_at`,
    [conversationId, userId, limit]);
  return r.rows;
}

export async function listConversations(db: Db, userId: string): Promise<Conversation[]> {
  return (await db.query<Conversation>('select id, title, created_at, updated_at from conversations where user_id = $1 order by updated_at desc limit 50', [userId])).rows;
}

export async function deleteConversation(db: Db, userId: string, id: string): Promise<boolean> {
  return ((await db.query('delete from conversations where id = $1 and user_id = $2', [id, userId])).rowCount ?? 0) > 0;
}
