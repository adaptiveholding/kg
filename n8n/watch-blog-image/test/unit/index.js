// `node --test test/unit` hands this directory to Node, which loads it as a module (this file).
// Import every *.test.mjs here so the documented command runs the whole suite.
import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
for (const f of readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort()) await import(new URL(f, dir));
