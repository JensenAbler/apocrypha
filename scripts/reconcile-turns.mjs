
import fs from 'node:fs';
import path from 'node:path';
import { turnLeafId, LOG_RECORD_BYTES } from '../src/storage.js';
const directory = process.argv[2];
if (!directory || process.argv[3] !== '--dry-run') throw new Error('Usage: node scripts/reconcile-turns.mjs <memory-directory> --dry-run');
const read = name => {try{return fs.readFileSync(path.join(directory,name));}catch(error){if(error.code==='ENOENT')return Buffer.alloc(0);throw error;}};
const log=read('LOG.txt'), bytes=read('TRANSCRIPTS.jsonl');
if(log.length % LOG_RECORD_BYTES)throw new Error('Partial log record: dry run does not repair it.');
if(bytes.length && bytes.at(-1)!==10)throw new Error('Partial transcript record: dry run does not repair it.');
const turns=bytes.length ? new TextDecoder('utf-8',{fatal:true}).decode(bytes).trimEnd().split('\n').map(JSON.parse):[];
const present=new Set(new TextDecoder('utf-8',{fatal:true}).decode(log).split('\n').map(turnLeafId).filter(Boolean));
console.log(JSON.stringify({dryRun:true,transcriptTurns:turns.length,existingLeaves:present.size,wouldAppend:turns.filter(t=>!present.has(t.id)).length}));
