// test/e2e/mock-wordpress.mjs answers like WordPress core (see the header of that file for the
// source references). Fast: in-process server on a free port, no n8n.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  startWordpressMock,
  getFilenameFromDisposition,
  sanitizeFileName,
  sanitizeTextField,
  checkFiletype,
  sniffImageMime,
  imageSize,
  kses,
  DEFAULT_LOGIN,
  DEFAULT_APP_PASSWORD,
  CREDENTIAL,
} from '../e2e/mock-wordpress.mjs';
import { makeJpeg, makePng } from '../e2e/mock-http.mjs';

const basic = (login = DEFAULT_LOGIN, pw = DEFAULT_APP_PASSWORD) => `Basic ${Buffer.from(`${login}:${pw}`).toString('base64')}`;
const md5hex = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function req(base, method, path, { headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  let json;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), json };
}

const upload = (base, bytes, { filename = 'rolex-submariner.jpg', type = 'image/jpeg', auth = basic(), disposition, extra = {}, query = '' } = {}) =>
  req(base, 'POST', `/wp-json/wp/v2/media${query}`, {
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      ...(type ? { 'Content-Type': type } : {}),
      ...(disposition === null ? {} : { 'Content-Disposition': disposition ?? `attachment; filename="${filename}"` }),
      ...extra,
    },
    body: bytes,
  });

const json = (obj, auth = basic()) => ({ headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(obj) });

test('WP helper ports: Content-Disposition, file names, file types, sniffing, sanitize_text_field', () => {
  // A::get_filename_from_disposition
  assert.equal(getFilenameFromDisposition(['attachment; filename="a b.jpg"']), 'a b.jpg');
  assert.equal(getFilenameFromDisposition(['attachment; filename=a.jpg']), 'a.jpg');
  assert.equal(getFilenameFromDisposition(['inline; filename="a.jpg"']), 'a.jpg'); // type not checked
  assert.equal(getFilenameFromDisposition(["attachment; filename*=UTF-8''a%20b.jpg"]), null); // RFC 5987 ignored
  assert.equal(getFilenameFromDisposition(["attachment; filename=\"a.jpg\"; filename*=UTF-8''b.jpg"]), 'a.jpg');
  assert.equal(getFilenameFromDisposition(['attachment; FILENAME="a.jpg"']), null); // key is case-sensitive
  assert.equal(getFilenameFromDisposition(['attachment']), null);
  assert.equal(getFilenameFromDisposition(['attachment; filename="a;b.jpg"']), '"a'); // split on every ";"
  assert.equal(getFilenameFromDisposition(['attachment; filename="a\\"b.jpg"']), 'a\\"b.jpg'); // no unescaping
  // sanitize_file_name
  assert.equal(sanitizeFileName('Rolex Submariner (1960).jpg'), 'Rolex-Submariner-1960.jpg');
  assert.equal(sanitizeFileName('Café Racer.png'), 'Cafe-Racer.png');
  assert.equal(sanitizeFileName('shell.php.jpg'), 'shell.php_.jpg');
  assert.equal(sanitizeFileName('a.tar.jpg'), 'a.tar_.jpg');
  assert.equal(sanitizeFileName('x.jpeg.jpg'), 'x.jpeg.jpg');
  // wp_check_filetype
  assert.deepEqual(checkFiletype('A.JPG'), { ext: 'JPG', type: 'image/jpeg' });
  assert.deepEqual(checkFiletype('a.svg'), { ext: false, type: false });
  assert.deepEqual(checkFiletype('noext'), { ext: false, type: false });
  // sniffing and size
  assert.equal(sniffImageMime(makeJpeg(10, 10)), 'image/jpeg');
  assert.equal(sniffImageMime(makePng(10, 10)), 'image/png');
  assert.equal(sniffImageMime(Buffer.from('<html><body>nope</body></html>')), false);
  assert.deepEqual(imageSize(makeJpeg(1600, 1067)), { width: 1600, height: 1067 });
  assert.deepEqual(imageSize(makePng(300, 200)), { width: 300, height: 200 });
  // _sanitize_text_fields
  assert.equal(sanitizeTextField('<b>Rolex</b>  Submariner\n 5513'), 'Rolex Submariner 5513');
  assert.equal(sanitizeTextField('Steel 100%2F gilt %ab dial'), 'Steel 100 gilt dial');
  assert.equal(sanitizeTextField('a < b'), 'a &lt; b');
  assert.equal(sanitizeTextField('50% off'), '50% off');
  // kses stand-in
  assert.equal(kses('<a href="https://x.org" onclick="evil()">x</a><script>bad()</script>'), '<a href="https://x.org">x</a>');
  assert.equal(kses('<p><em>Rolex</em> 5513</p>', 'title'), '<em>Rolex</em> 5513');
});

test('mock WordPress: raw-body media upload, Basic auth, WP-shaped response, stored bytes', async () => {
  const wp = await startWordpressMock({ quiet: true, port: 0, now: '2026-10-09T10:00:00Z' });
  try {
    const jpg = makeJpeg(1600, 1067);
    const r = await upload(wp.url, jpg, { filename: 'Rolex Submariner 5513.jpg', extra: { 'Content-MD5': md5hex(jpg) } });
    assert.equal(r.status, 201, r.text);
    assert.match(r.headers.get('content-type'), /^application\/json; charset=UTF-8$/);
    assert.equal(r.headers.get('location'), `${wp.url}/wp-json/wp/v2/media/${r.json.id}`);
    assert.equal(r.headers.get('x-wp-upload-attachment-id'), String(r.json.id));
    const a = r.json;
    assert.equal(a.type, 'attachment');
    assert.equal(a.status, 'inherit');
    assert.equal(a.media_type, 'image');
    assert.equal(a.mime_type, 'image/jpeg');
    assert.equal(a.title.raw, 'Rolex-Submariner-5513'); // stored file name without extension
    assert.deepEqual(a.caption, { raw: '', rendered: '' });
    assert.equal(a.alt_text, '');
    assert.equal(a.source_url, `${wp.url}/wp-content/uploads/2026/10/Rolex-Submariner-5513.jpg`);
    assert.equal(a.media_details.width, 1600);
    assert.equal(a.media_details.height, 1067);
    assert.equal(a.media_details.file, '2026/10/Rolex-Submariner-5513.jpg');
    assert.deepEqual(Object.keys(a.media_details.sizes), ['thumbnail', 'medium', 'medium_large', 'large', '1536x1536', 'full']);
    assert.equal(a.media_details.sizes.medium.source_url, `${wp.url}/wp-content/uploads/2026/10/Rolex-Submariner-5513-300x200.jpg`);
    // The bytes WordPress stored are the bytes sent.
    const file = await req(wp.url, 'GET', '/wp-content/uploads/2026/10/Rolex-Submariner-5513.jpg');
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/jpeg');
    assert.equal(sha256(file.buf), sha256(jpg));
    const st = wp.publicState().media[0];
    assert.equal(st.upload.mode, 'raw');
    assert.equal(st.upload.sha256, sha256(jpg));
    assert.equal(st.upload.filename_header, 'Rolex Submariner 5513.jpg');
    // Log: binary body as a summary, Authorization redacted.
    const log = wp.requests.find((e) => e.route === 'media.create');
    assert.deepEqual(log.body, { bytes: jpg.length, sha256: sha256(jpg), head_hex: jpg.subarray(0, 8).toString('hex') });
    assert.equal(log.headers.authorization, 'Basic <redacted>');
    assert.equal(log.headers['content-disposition'], 'attachment; filename="Rolex Submariner 5513.jpg"');
    assert.equal(log.user, DEFAULT_LOGIN);
    // Same name again: unique suffix; title follows the stored name.
    const r2 = await upload(wp.url, jpg, { filename: 'Rolex Submariner 5513.jpg' });
    assert.equal(r2.json.source_url, `${wp.url}/wp-content/uploads/2026/10/Rolex-Submariner-5513-1.jpg`);
    assert.equal(r2.json.title.raw, 'Rolex-Submariner-5513-1');
    assert.equal(r2.json.id, a.id + 1);
    // Query-string fields are applied on create (A::create_item).
    const r3 = await upload(wp.url, jpg, { query: '?alt_text=Rolex%20%3Cb%3E5513%3C%2Fb%3E&title=Rolex%205513' });
    assert.equal(r3.json.alt_text, 'Rolex 5513');
    assert.equal(r3.json.title.raw, 'Rolex 5513');
    // Wrong extension is corrected from the bytes; the Content-Type header does not matter.
    const r4 = await upload(wp.url, makePng(400, 300), { filename: 'dial.jpg', type: 'application/octet-stream' });
    assert.equal(r4.status, 201);
    assert.equal(r4.json.mime_type, 'image/png');
    assert.match(r4.json.source_url, /\/dial\.png$/);
    // Over 2560 px: "-scaled" source_url and original_image.
    const r5 = await upload(wp.url, makeJpeg(4000, 3000), { filename: 'big.jpg' });
    assert.match(r5.json.source_url, /\/big-scaled\.jpg$/);
    assert.equal(r5.json.media_details.original_image, 'big.jpg');
    assert.equal(r5.json.media_details.width, 2560);
    assert.equal(r5.json.media_details.height, 1920);
  } finally {
    await wp.close();
  }
});

test('mock WordPress: upload refusals in WordPress order, auth errors, multipart', async () => {
  const wp = await startWordpressMock({
    quiet: true,
    port: 0,
    users: {
      [DEFAULT_LOGIN]: { password: DEFAULT_APP_PASSWORD, role: 'author', id: 3 },
      contrib: { password: 'zzzz zzzz zzzz zzzz zzzz zzzz', role: 'contributor', id: 4 },
    },
  });
  try {
    const jpg = makeJpeg(800, 600);
    const code = (r) => [r.status, r.json && r.json.code];
    assert.deepEqual(code(await upload(wp.url, jpg, { auth: null })), [401, 'rest_cannot_create']);
    assert.deepEqual(code(await upload(wp.url, jpg, { auth: basic(DEFAULT_LOGIN, 'wrong') })), [401, 'incorrect_password']);
    assert.deepEqual(code(await upload(wp.url, jpg, { auth: basic('nobody') })), [401, 'invalid_username']);
    assert.deepEqual(code(await upload(wp.url, jpg, { auth: basic('a@b.example') })), [401, 'invalid_email']);
    // spaces in an application password do not matter
    assert.equal((await upload(wp.url, jpg, { auth: basic(DEFAULT_LOGIN, DEFAULT_APP_PASSWORD.replace(/ /g, '')) })).status, 201);
    assert.deepEqual(code(await upload(wp.url, jpg, { auth: basic('contrib', 'zzzzzzzzzzzzzzzzzzzzzzzz') })), [403, 'rest_cannot_create']);
    assert.deepEqual(code(await upload(wp.url, Buffer.alloc(0))), [400, 'rest_upload_no_data']);
    assert.deepEqual(code(await upload(wp.url, jpg, { type: null })), [400, 'rest_upload_no_content_type']);
    assert.deepEqual(code(await upload(wp.url, jpg, { disposition: null })), [400, 'rest_upload_no_content_disposition']);
    assert.deepEqual(code(await upload(wp.url, jpg, { disposition: "attachment; filename*=UTF-8''a.jpg" })), [400, 'rest_upload_invalid_disposition']);
    assert.deepEqual(code(await upload(wp.url, jpg, { extra: { 'Content-MD5': crypto.createHash('md5').update(jpg).digest('base64') } })), [412, 'rest_upload_hash_mismatch']);
    const bad = await upload(wp.url, Buffer.from('<html>not an image</html>'), { filename: 'x.jpg' });
    assert.deepEqual(code(bad), [500, 'rest_upload_sideload_error']);
    assert.equal(bad.json.message, 'Sorry, you are not allowed to upload this file type.');
    assert.deepEqual(code(await upload(wp.url, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { filename: 'x.svg', type: 'image/svg+xml' })), [500, 'rest_upload_sideload_error']);
    assert.deepEqual(code(await upload(wp.url, jpg, { filename: 'x.txt' })), [500, 'rest_upload_sideload_error']);
    assert.deepEqual(code(await upload(wp.url, jpg, { filename: 'noext' })), [500, 'rest_upload_sideload_error']);
    assert.equal(wp.publicState().media.length, 1); // only the one accepted upload above
    // Unknown route: 404 rest_no_route; bad credentials still win before routing.
    assert.deepEqual(code(await req(wp.url, 'GET', '/wp-json/wp/v2/nope', { headers: { Authorization: basic() } })), [404, 'rest_no_route']);
    assert.deepEqual(code(await req(wp.url, 'GET', '/wp-json/wp/v2/nope', { headers: { Authorization: basic(DEFAULT_LOGIN, 'x') } })), [401, 'incorrect_password']);
    // Multipart field "file" works too (A::upload_from_file); title from the original name.
    const fd = new FormData();
    fd.append('file', new Blob([jpg], { type: 'image/jpeg' }), 'Omega Speedmaster.jpg');
    fd.append('alt_text', 'Omega Speedmaster');
    const mp = await req(wp.url, 'POST', '/wp-json/wp/v2/media', { headers: { Authorization: basic() }, body: fd });
    assert.equal(mp.status, 201, mp.text);
    assert.equal(mp.json.title.raw, 'Omega Speedmaster');
    assert.equal(mp.json.alt_text, 'Omega Speedmaster');
    assert.equal(wp.publicState().media.at(-1).upload.mode, 'multipart');
    const fd2 = new FormData();
    fd2.append('image', new Blob([jpg], { type: 'image/jpeg' }), 'a.jpg');
    assert.deepEqual(code(await req(wp.url, 'POST', '/wp-json/wp/v2/media', { headers: { Authorization: basic() }, body: fd2 })), [500, 'rest_upload_unknown_error']);
  } finally {
    await wp.close();
  }
});

test('mock WordPress: attachment update (alt text, caption, title, description) and post featured_media', async () => {
  const wp = await startWordpressMock({ quiet: true, port: 0 });
  try {
    const up = await upload(wp.url, makeJpeg(1200, 800));
    const id = up.json.id;
    const caption = 'Photo: <a href="https://commons.wikimedia.org/wiki/File:X.jpg">X</a> by Jane, <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a><script>x()</script>';
    const u = await req(wp.url, 'POST', `/wp-json/wp/v2/media/${id}`, json({ alt_text: 'Rolex <b>Submariner</b>\n5513', caption, title: 'Rolex Submariner 5513', description: { raw: 'Source: <a href="https://x.org" onmouseover="y()">x</a>' } }));
    assert.equal(u.status, 200, u.text);
    assert.equal(u.json.alt_text, 'Rolex Submariner 5513');
    assert.equal(u.json.caption.raw, caption.replace('<script>x()</script>', '')); // author: kses keeps <a href>
    assert.equal(u.json.caption.rendered, `<p>${u.json.caption.raw}</p>\n`);
    assert.equal(u.json.title.raw, 'Rolex Submariner 5513');
    assert.equal(u.json.description.raw, 'Source: <a href="https://x.org">x</a>');
    assert.deepEqual(wp.requests.find((e) => e.route === 'media.update').updated, { media_id: id, fields: ['title', 'caption', 'description', 'alt_text'] });
    assert.equal((await req(wp.url, 'PATCH', `/wp-json/wp/v2/media/${id}`, json({ alt_text: 'x' }))).status, 200);
    assert.deepEqual([(await req(wp.url, 'POST', '/wp-json/wp/v2/media/99999', json({ alt_text: 'x' }))).json.code], ['rest_post_invalid_id']);
    const badJson = await req(wp.url, 'POST', `/wp-json/wp/v2/media/${id}`, { headers: { 'Content-Type': 'application/json', Authorization: basic() }, body: '{nope' });
    assert.deepEqual([badJson.status, badJson.json.code], [400, 'rest_invalid_json']);
    assert.deepEqual([(await req(wp.url, 'POST', `/wp-json/wp/v2/media/${id}`, json({ alt_text: 'x' }, null))).status], [401]);

    const post = (extra) =>
      req(wp.url, 'POST', '/wp-json/wp/v2/posts', json({ title: 'Watch market digest', slug: 'watch-digest', content: '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->', excerpt: 'e', status: 'draft', categories: [39], tags: [77], meta: { _yoast_wpseo_title: 't' }, ...extra }));
    const p1 = await post({ featured_media: id });
    assert.equal(p1.status, 201, p1.text);
    assert.equal(p1.json.featured_media, id);
    assert.equal(p1.json.status, 'draft');
    assert.deepEqual(p1.json.categories, [39]);
    assert.deepEqual(p1.json.meta, { footnotes: '' }); // Yoast keys are not registered for REST
    assert.equal(p1.json.content.block_version, 1);
    assert.equal(p1.headers.get('location'), `${wp.url}/wp-json/wp/v2/posts/${p1.json.id}`);
    assert.deepEqual(wp.state.posts.get(p1.json.id).received_meta, { _yoast_wpseo_title: 't' });
    const p2 = await post({ featured_media: String(id) }); // integral numeric string passes rest_is_integer
    assert.equal(p2.json.featured_media, id);
    assert.equal(p2.json.slug, 'watch-digest-2');
    const p3 = await post({ featured_media: 424242 }); // not an attachment: post still created, no thumbnail
    assert.equal(p3.status, 201);
    assert.equal(p3.json.featured_media, 0);
    assert.equal(wp.state.posts.get(p3.json.id).featured_media_result, 'ignored:rest_invalid_featured_media');
    const p4 = await post({}); // featured_media absent (JSON.stringify dropped undefined)
    assert.equal(p4.json.featured_media, 0);
    assert.equal(wp.state.posts.get(p4.json.id).received_featured_media, '(absent)');
    assert.equal((await post({ featured_media: 0 })).json.featured_media, 0);
    const p5 = await post({ featured_media: 'abc' });
    assert.deepEqual([p5.status, p5.json.code, p5.json.data.params.featured_media], [400, 'rest_invalid_param', 'featured_media is not of type integer.']);
    assert.deepEqual([(await post({ status: 'drafty' })).json.code], ['rest_invalid_param']);
    assert.deepEqual([(await post({ featured_media: null })).status], [201]); // null is skipped
    const anon = await req(wp.url, 'POST', '/wp-json/wp/v2/posts', json({ title: 'x' }, null));
    assert.deepEqual([anon.status, anon.json.code], [401, 'rest_cannot_create']);
    // the n8n credential test request
    const users = await req(wp.url, 'GET', '/wp-json/wp/v2/users', { headers: { Authorization: basic() } });
    assert.equal(users.json[0].slug, DEFAULT_LOGIN);
    assert.deepEqual(CREDENTIAL(wp.url).id, 'LPEXDGdEBrfFA7NC');
  } finally {
    await wp.close();
  }
});

test('mock WordPress: per-route error injection, sequences, runtime errors, body-size limit', async () => {
  const wp = await startWordpressMock({
    quiet: true,
    port: 0,
    maxBodyBytes: 50000,
    errors: { 'media.create': { sequence: [{ status: 413 }, { status: 401 }, { pass: true }] }, 'media.update': { status: 500 } },
  });
  try {
    const jpg = makeJpeg(400, 300);
    const r1 = await upload(wp.url, jpg);
    assert.equal(r1.status, 413);
    assert.match(r1.headers.get('content-type'), /^text\/html/);
    assert.match(r1.text, /413 Request Entity Too Large/);
    const r2 = await upload(wp.url, jpg);
    assert.deepEqual([r2.status, r2.json.code], [401, 'incorrect_password']);
    const r3 = await upload(wp.url, jpg);
    assert.equal(r3.status, 201);
    assert.equal(wp.publicState().media.length, 1); // injected failures store nothing
    const u = await req(wp.url, 'POST', `/wp-json/wp/v2/media/${r3.json.id}`, json({ alt_text: 'x' }));
    assert.deepEqual([u.status, u.json.code, u.json.data.status], [500, 'internal_server_error', 500]);
    assert.equal(wp.state.media.get(r3.json.id).alt_text, ''); // nothing changed
    assert.ok(wp.requests.find((e) => e.route === 'media.update').injected);
    // runtime change through the HTTP endpoint
    await req(wp.url, 'POST', '/__mock/errors', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ 'media.create': { status: 403 }, 'posts.create': { wp_error: 'rest_cannot_create', status: 401 } }) });
    const r4 = await upload(wp.url, jpg);
    assert.deepEqual([r4.status, r4.json.code], [403, 'rest_cannot_create']);
    const p = await req(wp.url, 'POST', '/wp-json/wp/v2/posts', json({ title: 'x' }));
    assert.deepEqual([p.status, p.json.code, p.json.data.status], [401, 'rest_cannot_create', 401]);
    wp.setErrors({ 'media.create': { wp_error: 'rest_upload_sideload_error' } });
    const r5 = await upload(wp.url, jpg);
    assert.deepEqual([r5.status, r5.json.code], [500, 'rest_upload_sideload_error']);
    wp.setErrors({});
    // nginx client_max_body_size stand-in
    const huge = await upload(wp.url, Buffer.concat([jpg, Buffer.alloc(60000)]));
    assert.equal(huge.status, 413);
    assert.equal(wp.requests.at(-1).route, 'nginx');
    // reset
    await req(wp.url, 'POST', '/__mock/reset-state');
    assert.deepEqual(wp.publicState().media, []);
  } finally {
    await wp.close();
  }
});
