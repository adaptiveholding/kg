// Image finder, step 3a: one item per (post, query), so the two search nodes run each query once.
// Input: the items of "Image: build queries" (one per post). Output per query:
// {post_index, rank, q, level, brand, model_family, model, reference, prominence, watch_index}, paired to its post.
// A post without usable queries emits nothing; "Image: pick photo" reports it as image_error.
const LEVELS = ['model', 'family', 'brand', 'generic'];
const MAX_Q_LENGTH = 200; // Openverse cuts q at 200 characters anyway

const str = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const int = (v, d) => (Number.isInteger(v) ? v : d);

const out = [];
let posts = [];
try { posts = $input.all(); } catch (e) { posts = []; }
if (!Array.isArray(posts)) posts = [];

for (let p = 0; p < posts.length; p++) {
  try {
    const json = posts[p] && posts[p].json;
    const queries = json && Array.isArray(json.image_queries) ? json.image_queries : [];
    for (let r = 0; r < queries.length; r++) {
      const e = queries[r];
      if (!e || typeof e !== 'object') continue;
      // Never send an empty q: Openverse would run a search without text and return unrelated popular images.
      const q = str(e.q).slice(0, MAX_Q_LENGTH).trim();
      if (!q) continue;
      const level = LEVELS.includes(e.level) ? e.level : 'generic';
      out.push({
        json: {
          post_index: p, rank: r, q, level,
          brand: str(e.brand), model_family: str(e.model_family), model: str(e.model), reference: str(e.reference),
          prominence: str(e.prominence), watch_index: int(e.watch_index, -1),
        },
        pairedItem: { item: p },
      });
    }
  } catch (e) {
    // A broken post item is skipped; the pick node reports it.
  }
}
return out;
