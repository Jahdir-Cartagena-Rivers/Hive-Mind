import { BrainError } from './brain.mjs';

// Convert explicit exports only. Do not infer a speaker or invent a source date.
export function normalizeKnowledgeExport(format, payload) {
  const entries = [], issues = [];
  const add = (text, speaker, origin, date) => {
    const recordedAt = typeof date === 'number' && Number.isFinite(date) && Math.abs(date * 1000) <= 8640000000000000 ? new Date(date * 1000).toISOString() : date;
    if (typeof text !== 'string' || !text.trim()) return;
    if (typeof speaker !== 'string' || !speaker || typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) {
      issues.push({origin, reason:'Missing speaker or source date'}); return;
    }
    // Split without changing original characters; each chunk has a stable location.
    for (let start = 0; start < text.length; start += 12000)
      entries.push({text:text.slice(start,start+12000),speaker,origin:`${origin}#${start}`,recordedAt});
  };
  if (format === 'chatgpt') {
    if (!Array.isArray(payload)) throw new BrainError(400,'Expected a ChatGPT conversations array.');
    for (const conversation of payload) {
      if (!conversation || typeof conversation.id !== 'string' || !conversation.mapping || typeof conversation.mapping !== 'object')
        throw new BrainError(400,'Invalid ChatGPT conversation.');
      // Import every message node, including branches; retain its explicit identity.
      for (const [id,node] of Object.entries(conversation.mapping)) {
        const m = node?.message;
        if (!m) continue;
        const parts = m.content?.parts;
        if (!Array.isArray(parts)) { issues.push({origin:`chatgpt:${conversation.id}/${id}`,reason:'Non-text content'}); continue; }
        parts.forEach((part,i)=>{
          if(typeof part === 'string') add(part,m.author?.role,`chatgpt:${conversation.id}/${id}/${i}`,m.create_time);
          else issues.push({origin:`chatgpt:${conversation.id}/${id}/${i}`,reason:'Non-text content'});
        });
      }
    }
  } else if (format === 'claude') {
    if (!Array.isArray(payload)) throw new BrainError(400,'Expected a Claude conversations array.');
    for(const conversation of payload) {
      if (!conversation || typeof conversation.uuid !== 'string' || !Array.isArray(conversation.chat_messages))
        throw new BrainError(400,'Invalid Claude conversation.');
      for(const message of conversation.chat_messages) {
        if(typeof message?.uuid !== 'string') throw new BrainError(400,'Claude message identity missing.');
        if(typeof message.text === 'string') add(message.text,message.sender,`claude:${conversation.uuid}/${message.uuid}`,message.created_at);
        else issues.push({origin:`claude:${conversation.uuid}/${message.uuid}`,reason:'Non-text content'});
      }
    }
  } else throw new BrainError(400,'Supported export formats: chatgpt, claude.');
  return {entries,issues};
}
