// Builds realistic "Render WP blocks" output items by running the real node code (render-wp-blocks.js)
// on the hand-written writer posts. Run directly to refresh rendered-posts.json:
//   node test/fixtures/generate.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCode, readText } from '../unit/harness.mjs';
import { WRITER_POSTS } from './writer-posts.mjs';

const RENDER_CODE = readText('test/fixtures/render-wp-blocks.js');
const OUT = new URL('./rendered-posts.json', import.meta.url);

// Same word count as the Watch Centro "Parse writer output" node.
const wordCount = p => [p.summary, p.takeaway, p.closing, ...(p.sections || []).flatMap(s => s.paragraphs || [])]
  .join(' ').split(/\s+/).filter(Boolean).length;

/** @returns {Promise<Record<string, object>>} name -> Render WP blocks output json */
export async function renderedPosts() {
  const out = {};
  for (const [name, { post, data_window }] of Object.entries(WRITER_POSTS)) {
    const input = [{ json: { ok: true, stage: 'reviewer', reason: '', post, word_count: wordCount(post), run_date: '2026-10-07', sanitized: { data_window } } }];
    const [item] = await runCode(RENDER_CODE, { input, nodes: { 'Parse + code checks (sanitizer)': [{ json: { sanitized: { data_window } } }] } });
    out[name] = item.json;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(OUT, JSON.stringify(await renderedPosts(), null, 2) + '\n');
  console.log('wrote', fileURLToPath(OUT));
}
