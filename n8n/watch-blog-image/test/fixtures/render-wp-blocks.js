// Verbatim copy of the "Render WP blocks" Code node from the Watch Centro workflow (test fixture only).
// Render the writer JSON into WordPress block markup using fixed templates.
const p = $input.first().json.post;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = t => `<!-- wp:paragraph -->\n<p>${esc(t)}</p>\n<!-- /wp:paragraph -->\n\n`;
const h2 = t => `<!-- wp:heading -->\n<h2 class="wp-block-heading">${esc(t)}</h2>\n<!-- /wp:heading -->\n\n`;
const sep = () => `<!-- wp:separator {"className":"is-style-wide"} -->\n<hr class="wp-block-separator has-alpha-channel-opacity is-style-wide"/>\n<!-- /wp:separator -->\n\n`;

let html = '';
const window = $input.first().json.sanitized?.data_window || $('Parse + code checks (sanitizer)').first().json.sanitized.data_window;
html += para(p.summary);
html += `<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size">Based on activity from ${esc(window)}.</p>\n<!-- /wp:paragraph -->\n\n`;

// Key takeaway box
html += `<!-- wp:group {"style":{"spacing":{"padding":{"top":"1.25em","bottom":"1.25em","left":"1.5em","right":"1.5em"}}},"backgroundColor":"base-2","layout":{"type":"constrained"}} -->\n<div class="wp-block-group has-base-2-background-color has-background" style="padding-top:1.25em;padding-right:1.5em;padding-bottom:1.25em;padding-left:1.5em"><!-- wp:paragraph -->\n<p><strong>Key takeaway:</strong> ${esc(p.takeaway)}</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:group -->\n\n`;

// At-a-glance row
if (Array.isArray(p.glance) && p.glance.length) {
  html += `<!-- wp:columns -->\n<div class="wp-block-columns">`;
  for (const g of p.glance.slice(0, 3)) {
    html += `<!-- wp:column -->\n<div class="wp-block-column"><!-- wp:paragraph -->\n<p><strong>${esc(g.label)}</strong><br>${esc(g.value)}</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:column -->`;
  }
  html += `</div>\n<!-- /wp:columns -->\n\n`;
}

const sections = Array.isArray(p.sections) ? p.sections : [];
sections.forEach((s, i) => {
  html += h2(s.heading);
  for (const t of (s.paragraphs || [])) html += para(t);
  // Put the table after the first section
  if (i === 0 && p.table && Array.isArray(p.table.rows) && p.table.rows.length) {
    const headers = (p.table.headers || []).slice(0, 4);
    const rows = p.table.rows.slice(0, 8);
    html += `<!-- wp:table {"className":"is-style-stripes"} -->\n<figure class="wp-block-table is-style-stripes"><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.slice(0, 4).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${p.table.caption ? `<figcaption class="wp-element-caption">${esc(p.table.caption)}</figcaption>` : ''}</figure>\n<!-- /wp:table -->\n\n`;
  }
  if (i < sections.length - 1) html += sep();
});

if (p.closing) html += para(p.closing);
html += `<!-- wp:paragraph {"fontSize":"small"} -->\n<p class="has-small-font-size"><em>This report describes community sentiment and activity. It is not an appraisal, price quote or financial advice.</em></p>\n<!-- /wp:paragraph -->`;

return [{ json: {
  title: p.title,
  slug: p.slug,
  excerpt: p.excerpt,
  content: html,
  seo_title: p.seo_title,
  meta_description: p.meta_description,
  focus_keyphrase: p.focus_keyphrase,
  word_count: $input.first().json.word_count
} }];
