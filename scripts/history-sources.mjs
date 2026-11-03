// Canonical visible-message readers shared by the one-time history rebuild.
import fs from 'node:fs';
const ZERO = '00000000-0000-4000-8000-000000000000';
export const clean = text => (typeof text === 'string' ? text : '')
  .replace(/⟦\s*mint\s+(apx-[a-z2-7]{4}-[a-z]{4})\s*⟧/gu, '$1')
  .replace(/⟦\s*mint\b/gu, '[mint]');
export const normalized = text => clean(text).replace(/(?:\[mint\]\s*)?apx-[a-z2-7]{4}-[a-z]{4}⟧?/gu, '').replace(/\s+/gu,' ').trim();
export function visibleText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join('\n\n');
  if (!value || typeof value !== 'object') return '';
  const type = value.type || value.content_type;
  if (['text','input_text','output_text','audio_transcription'].includes(type)) return value.text || visibleText(value.parts);
  if (['text_audio','multimodal_text'].includes(type)) return visibleText(value.parts) || visibleText(value.text);
  return '';
}
export function turnsOf(c) {
  let cur; const turns=[];
  for (const m of c.messages) {
    if (m.role === 'user') { cur={at:m.at,messageId:m.id,user:clean(m.text) || '[no text: attachment or image only]',assistant:[],sourceOrder:turns.length}; turns.push(cur); }
    else if (cur && m.text) cur.assistant.push(clean(m.text));
  }
  return turns.map(t=>({...t,assistant:t.assistant.join('\n\n')}));
}
function chainFrom(messages, leaf, id, parent) {
  const byId=new Map(messages.map(m=>[id(m),m])), seen=new Set(), chain=[];
  let node=byId.get(leaf);
  if (!node) throw new Error('Current branch leaf is missing: '+leaf);
  while(node) {
    if(seen.has(id(node))) throw new Error('Cycle in message tree');
    seen.add(id(node));chain.push(node);
    const p=parent(node);
    if(p && p!==ZERO && !byId.has(p)) throw new Error('Missing message parent: '+p);
    node=byId.get(p);
  }
  return chain.reverse();
}
export function parseClaude(data) {
  return data.map(c=>{
    let messages=c.chat_messages || [];
    if(c.current_leaf_message_uuid) messages=chainFrom(messages,c.current_leaf_message_uuid,m=>m.uuid,m=>m.parent_message_uuid);
    else if(messages.length && messages.every(m=>m.parent_message_uuid)) {
      const leaf=messages.reduce((a,b)=>Date.parse(b.created_at)>Date.parse(a.created_at)?b:a);
      messages=chainFrom(messages,leaf.uuid,m=>m.uuid,m=>m.parent_message_uuid);
    }
    const raw=messages.filter(m=>['human','assistant'].includes(m.sender));
    return {vendor:'claude',id:c.uuid,created:c.created_at,updated:c.updated_at || c.created_at,
      url:'https://claude.ai/chat/'+c.uuid,markers:raw.flatMap(m=>[...(m.text || visibleText(m.content)).matchAll(/⟦mint (apx-[a-z2-7]{4}-[a-z]{4})⟧/g)].map(x=>x[1])),
      messages:raw.map(m=>({id:m.uuid,role:m.sender==='human'?'user':'assistant',at:m.created_at,text:m.text || visibleText(m.content)}))};
  });
}
export function parseChatGPT(data) {
  return data.map(c=>{
    const id=c.conversation_id||c.id, mapping=c.mapping||{};
    const chain=c.current_node?chainFrom(Object.values(mapping),c.current_node,n=>n.id,n=>n.parent):[];
    const messages=[], markers=[];
    for(const n of chain) {
      const m=n.message,role=m?.author?.role;
      if(!['user','assistant'].includes(role) || m.metadata?.is_visually_hidden_from_conversation)continue;
      if(role==='assistant' && ((m.recipient && m.recipient!=='all') || ['analysis','justify','confidence'].includes(m.channel)))continue;
      if(!['text','multimodal_text','audio_transcription','text_audio'].includes(m.content?.content_type))continue;
      const body=visibleText(m.content);
      if(role==='assistant') markers.push(...[...body.matchAll(/⟦mint (apx-[a-z2-7]{4}-[a-z]{4})⟧/g)].map(x=>x[1]));
      messages.push({id:m.id||n.id,role,at:new Date((m.create_time??c.create_time)*1000).toISOString(),text:body});
    }
    return {vendor:'chatgpt',id,created:new Date(c.create_time*1000).toISOString(),updated:new Date((c.update_time??c.create_time)*1000).toISOString(),url:'https://chatgpt.com/c/'+id,messages,markers};
  });
}
export function readSources(specs) {
  const result=[];
  for(const {vendor,file} of specs) {
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Array.isArray(data))throw new Error('Expected conversation array: '+file);
    for(const c of (vendor==='claude'?parseClaude(data):parseChatGPT(data)))result.push({...c,file,turns:turnsOf(c)});
  }
  return result;
}
