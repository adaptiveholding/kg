#!/usr/bin/env node
// Zero-dependency mock of the WordPress REST API (https://watchcentro.com/wp-json/wp/v2) for the
// step 4-6 e2e tests: media upload from a raw body, attachment update, post creation with
// featured_media. Built on mock-http.mjs (JSONL request log, response specs, /__mock/*).
//
// Behaviour follows WordPress core trunk (wordpress-develop @ 8a5b626cfbd2, 2026-10-09). Sources:
//   A = src/wp-includes/rest-api/endpoints/class-wp-rest-attachments-controller.php
//   P = src/wp-includes/rest-api/endpoints/class-wp-rest-posts-controller.php
//   F = src/wp-admin/includes/file.php, FN = src/wp-includes/functions.php
//   U = src/wp-includes/user.php, R = src/wp-includes/rest-api.php, RQ = rest-api/class-wp-rest-request.php
//
// Routes
//   POST  /wp-json/wp/v2/media             create from a raw body (A::create_item -> insert_attachment ->
//                                          upload_from_data) or from multipart field "file" (upload_from_file)
//   POST|PUT|PATCH /wp-json/wp/v2/media/<id>  update title/caption/description/alt_text/post (A::update_item)
//   GET   /wp-json/wp/v2/media/<id>        the stored attachment (context=edit shape)
//   POST  /wp-json/wp/v2/posts             create a post (P::create_item), featured_media like WP
//   GET   /wp-json/wp/v2/posts/<id>        the stored post
//   GET   /wp-json/wp/v2/users/me          the authenticated user (credential test uses /users)
//   GET   /wp-json/wp/v2/users             [the user] (n8n wordpressApi credential test request)
//   GET   /wp-content/uploads/<y>/<m>/<f>  the uploaded bytes (source_url, sub-size URLs)
//   GET   /__mock/state                    {media: [...], posts: [...]} (bytes as size + sha256)
//   POST  /__mock/errors                   JSON body replaces the error map at runtime ({} clears it)
//   POST  /__mock/reset-state              forget media, posts, error-map hit counters
//   GET   /__mock/requests, POST /__mock/reset (log; see mock-http.mjs)
//
// Authentication (U::wp_validate_application_password, U::wp_authenticate_application_password,
// R::rest_application_password_check_errors, run at rest_authentication_errors before routing):
//   - HTTP Basic user:application-password (what the n8n wordpressApi credential sends: axios `auth`).
//     Non-alphanumerics are stripped from the password before checking (U, preg_replace [^a-z\d]),
//     so "abcd EFGH 1234 ijkl MNOP 5678" and "abcdEFGH1234ijklMNOP5678" are the same password.
//   - unknown login -> 401 invalid_username (or invalid_email when it looks like an e-mail);
//     wrong password -> 401 incorrect_password. These fire for EVERY route, before routing.
//   - no Authorization header -> anonymous: create/update are refused by the permission checks
//     with status rest_authorization_required_code() = 401 when logged out, 403 when logged in (R).
//   - roles (WP defaults): administrator/editor (unfiltered_html, upload_files), author (upload_files,
//     no unfiltered_html), contributor (edit_posts only), subscriber (read). Attachments map
//     create_posts to upload_files (post.php register_post_type('attachment')), so a contributor
//     gets 403 rest_cannot_create "Sorry, you are not allowed to create posts as this user." (P).
//
// Media create from a raw body, checked in the order of A::upload_from_data:
//   empty body -> 400 rest_upload_no_data; no Content-Type -> 400 rest_upload_no_content_type;
//   no Content-Disposition -> 400 rest_upload_no_content_disposition; no `filename=` parameter ->
//   400 rest_upload_invalid_disposition (A::get_filename_from_disposition, ported exactly: only the
//   plain `filename` key, case-sensitive; `filename*=` (RFC 5987) is NOT decoded; quotes are removed
//   only when the value both starts and ends with `"`; values are split on every `;`).
//   Content-MD5 when present must equal the HEX md5 of the body (not base64) -> else 412
//   rest_upload_hash_mismatch. Then wp_handle_sideload (F::_wp_handle_upload ->
//   FN::wp_check_filetype_and_ext): the stored MIME type comes from the FILENAME EXTENSION checked
//   against get_allowed_mime_types() and from sniffing the bytes (FN::wp_get_image_mime), NOT from
//   the Content-Type header (which must only be non-empty). An image whose bytes are another image
//   type is renamed to the right extension; a disallowed extension or non-image bytes behind an
//   image extension -> 500 rest_upload_sideload_error "Sorry, you are not allowed to upload this
//   file type." (users with unfiltered_upload, i.e. multisite super admins, are not emulated).
//   The file name is sanitize_file_name()d and made unique (-1, -2, ...) in uploads/YYYY/MM.
//   The title defaults to the stored file name without extension (A::insert_attachment), unless
//   `title` is in the query string. Query-string alt_text/caption/description/title/post are
//   applied on create too (A::create_item). Success: 201, Location, X-WP-Upload-Attachment-ID.
//   Images wider or taller than 2560 px get a "-scaled" source_url and media_details.original_image
//   (wp-admin/includes/image.php big_image_size_threshold).
//   No WordPress size limit applies to raw-body uploads on a single site (A::check_upload_size only
//   runs on multisite); oversize requests are refused by the web server (nginx default
//   client_max_body_size is 1 MB) with an HTML 413 page. Emulated with opts.maxBodyBytes.
//
// Media update (A::update_item, A::prepare_item_for_database, P::prepare_item_for_database):
//   title/caption/description accept a string or {raw}; alt_text is a string run through
//   sanitize_text_field (A::get_item_schema arg_options). Unknown id -> 404 rest_post_invalid_id.
//   Users without unfiltered_html get kses on save (kses.php kses_init_filters: title_save_pre ->
//   wp_filter_kses, content_save_pre/excerpt_save_pre -> wp_filter_post_kses); emulated LIGHTLY:
//   script/style/iframe/object elements, on* attributes and javascript: URLs are removed; titles
//   keep only the inline tags of $allowedtags. <a href> survives in captions for every role.
//
// Post create (P::create_item, P::handle_featured_media, RQ::has_valid_params):
//   featured_media must validate as an integer (rest_is_integer: ints and integral numeric strings)
//   or 400 rest_invalid_param; null/absent is skipped. A non-zero id that is not an existing image
//   attachment does NOT fail the request: P::create_item ignores handle_featured_media's
//   rest_invalid_featured_media error, the post is created (201) with featured_media 0.
//   0 -> no thumbnail. status must be publish|future|draft|pending|private. Unregistered meta keys
//   are silently dropped (fields/class-wp-rest-meta-fields.php update_value); the request's meta is
//   kept in the mock state as `received_meta`.
//
// Error injection: opts.errors (object or path of a JSON file re-read per request), keyed by route:
//   "media.create", "media.update", "media.get", "posts.create", "posts.get", "users", "uploads".
//   Value: any mock-http.mjs response spec ({json}, {raw}, {hang}, {reset}, {sequence: [...]}, ...),
//   or {status: N} for the WordPress body of that status (401 incorrect_password, 403
//   rest_cannot_create/rest_cannot_edit, 404 rest_post_invalid_id, 400 rest_upload_file_too_big
//   (media.create) / rest_invalid_param, 412 rest_upload_hash_mismatch, 413 nginx HTML page, 500
//   internal_server_error "critical error" JSON, 502/503/504 nginx HTML), or {wp_error: code,
//   status?, message?}, or {pass: true} (handle normally; useful inside a sequence). Injection runs
//   after the request is read and logged, before authentication, and stores nothing.
//
// Options: {port, host, logFile, quiet, users, errors, maxBodyBytes, publicBase, firstId,
//   registeredMeta, thumbnailSupport, now}. users: {login: {password, role, id?, email?, name?}};
//   default {"watchcentro-bot": {password: DEFAULT_APP_PASSWORD, role: "author", id: 3}}.
//
// CLI:  node mock-wordpress.mjs [--port 18558] [--errors e.json] [--log requests.jsonl]
//   prints "MOCK_WORDPRESS_LISTENING http://127.0.0.1:<port>" once ready.
// Module: import { startWordpressMock, REAL_BASE, CREDENTIAL } from './mock-wordpress.mjs'

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpMock, resolveSpec, sendJson, cliArg } from './mock-http.mjs';

export const REAL_BASE = 'https://watchcentro.com';
export const PREFERRED_PORT = 18558;
export const DEFAULT_LOGIN = 'watchcentro-bot';
export const DEFAULT_APP_PASSWORD = 'abcd EFGH 1234 ijkl MNOP 5678';
/** n8n credential export for the Watch Centro wordpressApi credential, pointed at a mock. */
export const CREDENTIAL = (url) => ({
  id: 'LPEXDGdEBrfFA7NC',
  name: 'WatchCentro',
  type: 'wordpressApi',
  data: { username: DEFAULT_LOGIN, password: DEFAULT_APP_PASSWORD, url, allowUnauthorizedCerts: false },
});

const JSON_CT = 'application/json; charset=UTF-8';
// Lower-case names: mock-http's sendJson sets 'content-type', and Node sends both spellings otherwise.
const WP_HEADERS = {
  'content-type': JSON_CT,
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
  'access-control-expose-headers': 'X-WP-Total, X-WP-TotalPages, Link',
  'access-control-allow-headers': 'Authorization, X-WP-Nonce, Content-Disposition, Content-MD5, Content-Type',
};

// ---------------------------------------------------------------------------------------------
// Ports of WordPress helpers (exported for the unit tests)

/** A::get_filename_from_disposition, ported line by line. Takes an array of header values. */
export function getFilenameFromDisposition(values) {
  let filename = null;
  for (let value of [].concat(values ?? [])) {
    value = String(value).trim();
    if (!value.includes(';')) continue;
    const attrParts = value.slice(value.indexOf(';') + 1).split(';');
    const attributes = {};
    for (const part of attrParts) {
      if (!part.includes('=')) continue;
      const i = part.indexOf('=');
      attributes[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    if (!attributes.filename) continue; // PHP empty(): '' and '0' are empty
    if (attributes.filename === '0') continue;
    filename = attributes.filename.trim();
    if (filename.startsWith('"') && filename.endsWith('"')) filename = filename.slice(1, -1);
  }
  return filename;
}

// FN::wp_get_mime_types, image and common document entries (the rest are never uploaded here).
export const MIME_TYPES = {
  'jpg|jpeg|jpe': 'image/jpeg',
  gif: 'image/gif',
  png: 'image/png',
  bmp: 'image/bmp',
  'tiff|tif': 'image/tiff',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  heics: 'image/heic-sequence',
  heifs: 'image/heif-sequence',
  'txt|asc|c|cc|h|srt': 'text/plain',
  csv: 'text/csv',
  pdf: 'application/pdf',
  zip: 'application/zip',
  'mp4|m4v': 'video/mp4',
  mp3: 'audio/mpeg',
};
// FN::wp_check_filetype_and_ext getimagesize_mimes_to_exts
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** FN::wp_check_filetype: {ext, type} from the file name (case-insensitive), or false/false. */
export function checkFiletype(filename) {
  for (const [exts, mime] of Object.entries(MIME_TYPES)) {
    const m = new RegExp(`\\.(${exts})$`, 'i').exec(String(filename));
    if (m) return { ext: m[1], type: mime };
  }
  return { ext: false, type: false };
}

/** FN::wp_get_image_mime stand-in (exif_imagetype magic numbers). */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.subarray(4, 12).toString('latin1') === 'ftypavif') return 'image/avif';
  const tiff = buf.subarray(0, 4).toString('hex');
  if (tiff === '49492a00' || tiff === '4d4d002a') return 'image/tiff';
  return false;
}

/** Pixel size of a JPEG, PNG, GIF or WebP (VP8/VP8L/VP8X), or null. */
export function imageSize(buf) {
  const mime = sniffImageMime(buf);
  try {
    if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (mime === 'image/gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (mime === 'image/jpeg') {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) return null;
        const marker = buf[o + 1];
        const len = buf.readUInt16BE(o + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        o += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp') {
      const kind = buf.subarray(12, 16).toString('latin1');
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    /* truncated */
  }
  return null;
}

/** formatting.php sanitize_file_name (remove_accents approximated by NFD + dropping marks). */
export function sanitizeFileName(name) {
  let f = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '');
  f = f.replace(/\p{Zs}/gu, ' ');
  for (const c of ['?', '[', ']', '/', '\\', '=', '<', '>', ':', ';', ',', "'", '"', '&', '$', '#', '*', '(', ')', '|', '~', '`', '!', '{', '}', '%', '+', '’', '«', '»', '”', '“', '\0']) {
    f = f.split(c).join('');
  }
  f = f.replace(/%20|\+/g, '-');
  f = f.replace(/\.{2,}/g, '.');
  f = f.replace(/[\r\n\t -]+/g, '-');
  f = f.replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (!f.includes('.')) {
    const t = checkFiletype(`test.${f}`);
    if (t.ext && t.ext === f) f = `unnamed-file.${t.ext}`;
  }
  const parts = f.split('.');
  if (parts.length <= 2) return f;
  let out = parts.shift();
  const ext = parts.pop();
  for (const part of parts) {
    out += `.${part}`;
    if (/^[a-zA-Z]{2,5}\d?$/.test(part) && !checkFiletype(`x.${part}`).ext) out += '_';
  }
  return `${out}.${ext}`;
}

/**
 * formatting.php _sanitize_text_fields: a lone "<" becomes "&lt;" (wp_pre_kses_less_than), tags and
 * script/style bodies are stripped (wp_strip_all_tags), whitespace runs become one space, and
 * percent-encoded octets ("%2F", "%ab") are REMOVED.
 */
export function sanitizeTextField(s) {
  if (s !== null && typeof s === 'object') return '';
  let t = String(s ?? '');
  if (t.includes('<')) {
    t = t.replace(/<(?![a-zA-Z/!?])/g, '&lt;');
    t = t.replace(/<(script|style)[^>]*?>[\s\S]*?<\/\1>/gi, '');
    t = t.replace(/<[^>]*(>|$)/g, '');
  }
  t = t.replace(/[\r\n\t ]+/g, ' ').trim();
  let found = false;
  while (/%[a-f0-9]{2}/i.test(t)) {
    t = t.replace(/%[a-f0-9]{2}/i, '');
    found = true;
  }
  return found ? t.replace(/ +/g, ' ').trim() : t;
}

const INLINE_TAGS = ['a', 'abbr', 'acronym', 'b', 'blockquote', 'cite', 'code', 'del', 'em', 'i', 'q', 's', 'strike', 'strong'];
/** Light kses stand-in (see header). mode 'title' keeps only $allowedtags, 'post' everything safe. */
export function kses(html, mode = 'post') {
  let s = String(html ?? '');
  s = s.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1=$2$2');
  if (mode === 'title') {
    s = s.replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (m, tag) => (INLINE_TAGS.includes(tag.toLowerCase()) ? m : ''));
  }
  return s;
}

/** sanitize_title-ish slug (lower case, dashes). */
function slugify(s) {
  return (
    String(s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z0-9#]+;/g, '')
      .replace(/[^a-z0-9 _-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || ''
  );
}

/** rest_is_integer */
function isRestInteger(v) {
  if (typeof v === 'boolean' || v === null || v === undefined || Array.isArray(v) || typeof v === 'object') return false;
  if (typeof v === 'string' && !/^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v)) return false;
  const n = Number(v);
  return Number.isFinite(n) && Math.round(n) === n;
}

const ROLE_CAPS = {
  administrator: ['read', 'edit_posts', 'publish_posts', 'upload_files', 'edit_others_posts', 'unfiltered_html'],
  editor: ['read', 'edit_posts', 'publish_posts', 'upload_files', 'edit_others_posts', 'unfiltered_html'],
  author: ['read', 'edit_posts', 'publish_posts', 'upload_files'],
  contributor: ['read', 'edit_posts'],
  subscriber: ['read'],
};

// WordPress error bodies (R::rest_convert_error_to_response shape: {code, message, data: {status}}).
const wpError = (code, message, status, extra = {}) => ({ status, json: { code, message, data: { status, ...extra } }, headers: WP_HEADERS });
const nginxPage = (status, text) => ({
  status,
  raw: `<html>\r\n<head><title>${status} ${text}</title></head>\r\n<body>\r\n<center><h1>${status} ${text}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n`,
  contentType: 'text/html',
});
// class-wp-fatal-error-handler.php display_default_error_template -> FN::_json_wp_die_handler
const CRITICAL_ERROR = {
  code: 'internal_server_error',
  message:
    '<p>There has been a critical error on this website.</p><p><a href="https://wordpress.org/documentation/article/faq-troubleshooting/">Learn more about troubleshooting WordPress.</a></p>',
  data: { status: 500 },
  additional_errors: [],
};

export const ERRORS = {
  incorrect_password: () => wpError('incorrect_password', 'The provided password is an invalid application password.', 401),
  invalid_username: () =>
    wpError('invalid_username', '<strong>Error:</strong> Unknown username. Check again or try your email address.', 401),
  invalid_email: () =>
    wpError('invalid_email', '<strong>Error:</strong> Unknown email address. Check again or try your username.', 401),
  rest_cannot_create: (status) => wpError('rest_cannot_create', 'Sorry, you are not allowed to create posts as this user.', status),
  rest_cannot_edit: (status) => wpError('rest_cannot_edit', 'Sorry, you are not allowed to edit this post.', status),
  rest_post_invalid_id: () => wpError('rest_post_invalid_id', 'Invalid post ID.', 404),
  rest_no_route: () => wpError('rest_no_route', 'No route was found matching the URL and request method.', 404),
  rest_upload_no_data: () => wpError('rest_upload_no_data', 'No data supplied.', 400),
  rest_upload_no_content_type: () => wpError('rest_upload_no_content_type', 'No Content-Type supplied.', 400),
  rest_upload_no_content_disposition: () => wpError('rest_upload_no_content_disposition', 'No Content-Disposition supplied.', 400),
  rest_upload_invalid_disposition: () =>
    wpError(
      'rest_upload_invalid_disposition',
      'Invalid Content-Disposition supplied. Content-Disposition needs to be formatted as `attachment; filename="image.png"` or similar.',
      400,
    ),
  rest_upload_hash_mismatch: () => wpError('rest_upload_hash_mismatch', 'Content hash did not match expected.', 412),
  rest_upload_sideload_error: (status, message) =>
    wpError('rest_upload_sideload_error', message || 'Sorry, you are not allowed to upload this file type.', 500),
  rest_upload_unknown_error: (status, message) => wpError('rest_upload_unknown_error', message || 'Specified file failed upload test.', 500),
  rest_upload_file_too_big: () => wpError('rest_upload_file_too_big', 'This file is too big. Files must be less than 1500 KB in size.', 400),
  rest_invalid_json: () =>
    wpError('rest_invalid_json', 'Invalid JSON body passed.', 400, { json_error_code: 4, json_error_message: 'Syntax error' }),
  internal_server_error: () => ({ status: 500, json: CRITICAL_ERROR, headers: WP_HEADERS }),
};

function invalidParam(param, message) {
  return wpError('rest_invalid_param', `Invalid parameter(s): ${param}`, 400, {
    params: { [param]: message },
    details: { [param]: { code: 'rest_invalid_type', message, data: { param } } },
  });
}

/** {status: N} shorthand -> WordPress-like body for that route. */
export function statusSpec(route, status) {
  switch (status) {
    case 400:
      return route === 'media.create' ? ERRORS.rest_upload_file_too_big() : invalidParam('title', 'title is not of type string.');
    case 401:
      return ERRORS.incorrect_password();
    case 403:
      return route === 'media.update' ? ERRORS.rest_cannot_edit(403) : ERRORS.rest_cannot_create(403);
    case 404:
      return route.endsWith('.get') || route === 'media.update' ? ERRORS.rest_post_invalid_id() : ERRORS.rest_no_route();
    case 412:
      return ERRORS.rest_upload_hash_mismatch();
    case 413:
      return nginxPage(413, 'Request Entity Too Large');
    case 500:
      return ERRORS.internal_server_error();
    case 502:
      return nginxPage(502, 'Bad Gateway');
    case 503:
      return nginxPage(503, 'Service Temporarily Unavailable');
    case 504:
      return nginxPage(504, 'Gateway Time-out');
    default:
      return wpError('mock_error', `mock error ${status}`, status);
  }
}

// ---------------------------------------------------------------------------------------------
// Request helpers

/** Multipart/form-data parser (enough for one file field plus text fields). */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const parts = [];
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (buf.subarray(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(boundary, start);
    if (next === -1) break;
    const part = buf.subarray(start + 2, next - 2); // skip CRLF after boundary and before next
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const head = part.subarray(0, sep).toString('utf8');
      const headers = {};
      for (const line of head.split('\r\n')) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      const cd = headers['content-disposition'] || '';
      const name = (/\bname="([^"]*)"/i.exec(cd) || [])[1];
      const filename = (/\bfilename="([^"]*)"/i.exec(cd) || [])[1];
      parts.push({ name, filename, type: headers['content-type'], data: part.subarray(sep + 4) });
    }
    pos = next;
  }
  return parts;
}

function parseBasic(header) {
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return null;
  const decoded = Buffer.from(m[1].trim(), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { login: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

const stripPw = (s) => String(s ?? '').replace(/[^a-z\d]/gi, '');

function loadErrors(errors) {
  if (!errors) return {};
  if (typeof errors === 'object') return errors;
  try {
    return JSON.parse(fs.readFileSync(errors, 'utf8'));
  } catch (err) {
    process.stderr.write(`[mock-wordpress] cannot read errors ${errors}: ${err.message}\n`);
    return {};
  }
}

const iso = (d) => d.toISOString().slice(0, 19);
const rendered = (raw) => (raw ? `<p>${raw}</p>\n` : ''); // wpautop of a single paragraph

// Registered image sub-sizes (media.php defaults): name -> [w, h, crop]
const SUB_SIZES = [
  ['thumbnail', 150, 150, true],
  ['medium', 300, 300, false],
  ['medium_large', 768, 0, false],
  ['large', 1024, 1024, false],
  ['1536x1536', 1536, 1536, false],
  ['2048x2048', 2048, 2048, false],
];

function fitSize(w, h, maxW, maxH) {
  const rw = maxW ? maxW / w : Infinity;
  const rh = maxH ? maxH / h : Infinity;
  const r = Math.min(rw, rh);
  if (r >= 1) return null;
  return [Math.max(1, Math.round(w * r)), Math.max(1, Math.round(h * r))];
}

// ---------------------------------------------------------------------------------------------
// The mock

export function startWordpressMock(opts = {}) {
  const users = opts.users || { [DEFAULT_LOGIN]: { password: DEFAULT_APP_PASSWORD, role: 'author', id: 3 } };
  const userList = Object.entries(users).map(([login, u], i) => ({
    login,
    id: u.id ?? 3 + i,
    name: u.name || login,
    email: u.email || `${login}@watchcentro.example`,
    role: u.role || 'author',
    password: u.password,
  }));
  const state = { media: new Map(), posts: new Map(), nextId: opts.firstId ?? 1001, files: new Map() };
  const hits = new Map();
  let errorsOverride = null;
  let baseUrl = null; // set once listening
  const pub = () => (opts.publicBase || baseUrl).replace(/\/$/, '');
  const now = () => (typeof opts.now === 'function' ? opts.now() : opts.now ? new Date(opts.now) : new Date());
  const thumbnailSupport = opts.thumbnailSupport !== false;
  const registeredMeta = opts.registeredMeta || [];

  const can = (user, cap) => !!user && (ROLE_CAPS[user.role] || []).includes(cap);

  function authenticate(headers) {
    const basic = parseBasic(headers.authorization);
    if (!basic) return { user: null };
    const user = userList.find((u) => u.login === basic.login) || userList.find((u) => u.email === basic.login);
    if (!user) return { error: /@/.test(basic.login) ? ERRORS.invalid_email() : ERRORS.invalid_username() };
    if (stripPw(basic.password) !== stripPw(user.password)) return { error: ERRORS.incorrect_password() };
    return { user };
  }

  function injected(route) {
    const map = errorsOverride ?? loadErrors(opts.errors);
    const { key, spec: found } = resolveSpec(map, route);
    if (found === undefined) return null;
    let spec = found;
    const nth = hits.get(key) || 0;
    hits.set(key, nth + 1);
    if (spec && typeof spec === 'object' && Array.isArray(spec.sequence)) spec = spec.sequence[Math.min(nth, spec.sequence.length - 1)];
    if (!spec || spec.pass) return null;
    if (typeof spec === 'object' && spec.wp_error) {
      const fn = ERRORS[spec.wp_error];
      const base = fn ? fn(spec.status, spec.message) : wpError(spec.wp_error, spec.message || spec.wp_error, spec.status || 400);
      if (spec.status) {
        base.status = spec.status;
        base.json = { ...base.json, data: { ...base.json.data, status: spec.status } };
      }
      if (spec.message) base.json = { ...base.json, message: spec.message };
      return base;
    }
    if (typeof spec === 'object' && spec.status && spec.json === undefined && spec.raw === undefined && spec.fixture === undefined && !spec.hang && !spec.reset) {
      return { ...statusSpec(route, spec.status), ...(spec.headers ? { headers: { ...WP_HEADERS, ...spec.headers } } : {}), ...(spec.delay_ms ? { delay_ms: spec.delay_ms } : {}) };
    }
    return spec;
  }

  function userJson(u) {
    return {
      id: u.id,
      name: u.name,
      url: '',
      description: '',
      link: `${pub()}/author/${u.login}/`,
      slug: u.login,
      avatar_urls: {},
      meta: [],
      _links: { self: [{ href: `${pub()}/wp-json/wp/v2/users/${u.id}` }] },
    };
  }

  // ---- media --------------------------------------------------------------------------------

  function mediaJson(a) {
    const sizes = {};
    for (const s of a.sizes) {
      sizes[s.name] = { file: s.file, width: s.width, height: s.height, filesize: s.filesize, mime_type: a.mime_type, source_url: `${a.dirUrl}/${s.file}` };
    }
    sizes.full = { file: a.file, width: a.width, height: a.height, mime_type: a.mime_type, source_url: a.source_url };
    const media_details = {
      width: a.width,
      height: a.height,
      file: `${a.subdir}/${a.file}`,
      filesize: a.filesize,
      sizes,
      image_meta: { aperture: '0', credit: '', camera: '', caption: '', created_timestamp: '0', copyright: '', focal_length: '0', iso: '0', shutter_speed: '0', title: '', orientation: '0', keywords: [] },
    };
    if (a.original_image) media_details.original_image = a.original_image;
    return {
      id: a.id,
      date: iso(a.date),
      date_gmt: iso(a.date),
      guid: { rendered: a.guid, raw: a.guid },
      modified: iso(a.modified),
      modified_gmt: iso(a.modified),
      slug: a.slug,
      status: 'inherit',
      type: 'attachment',
      link: `${pub()}/${a.slug}/`,
      title: { raw: a.title, rendered: a.title },
      author: a.author,
      featured_media: 0,
      comment_status: 'open',
      ping_status: 'closed',
      template: '',
      meta: [],
      permalink_template: `${pub()}/?attachment_id=${a.id}`,
      generated_slug: a.slug,
      class_list: [`post-${a.id}`, 'attachment', 'type-attachment', 'status-inherit', 'hentry'],
      description: { raw: a.description, rendered: rendered(a.description) },
      caption: { raw: a.caption, rendered: rendered(a.caption) },
      alt_text: a.alt_text,
      media_type: 'image',
      mime_type: a.mime_type,
      media_details,
      post: a.post || null,
      source_url: a.source_url,
      missing_image_sizes: [],
      _links: {
        self: [{ href: `${pub()}/wp-json/wp/v2/media/${a.id}`, targetHints: { allow: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] } }],
        collection: [{ href: `${pub()}/wp-json/wp/v2/media` }],
        about: [{ href: `${pub()}/wp-json/wp/v2/types/attachment` }],
        author: [{ embeddable: true, href: `${pub()}/wp-json/wp/v2/users/${a.author}` }],
      },
    };
  }

  function uniqueName(subdir, name) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    let n = 1;
    const taken = (f) => state.files.has(`${subdir}/${f}`) || state.files.has(`${subdir}/${f.replace(/\.[^.]+$/, (e) => e.toLowerCase())}`);
    while (taken(candidate)) candidate = `${base}-${n++}${ext}`;
    return candidate;
  }

  // _wp_handle_upload + wp_insert_attachment + wp_generate_attachment_metadata, in memory.
  function storeUpload(ctx, user, { bytes, name, contentType, mode, query, originalName }) {
    // F::_wp_handle_upload: empty file
    if (!bytes.length) return { error: 'File is empty. Please upload something more substantial.' };
    let { ext, type } = checkFiletype(name);
    let properName = name;
    let realMime = false;
    if (type && type.startsWith('image/')) {
      realMime = sniffImageMime(bytes);
      if (realMime && realMime !== type && MIME_TO_EXT[realMime]) {
        const parts = name.split('.');
        parts.pop();
        parts.push(MIME_TO_EXT[realMime]);
        properName = parts.join('.');
        ({ ext, type } = checkFiletype(properName));
      } else if (realMime && realMime !== type) {
        realMime = false;
      }
    }
    // finfo stand-in: an image extension over bytes that are not an image is refused.
    if (type && !realMime && type.startsWith('image/')) {
      type = false;
      ext = false;
    }
    // finfo stand-in the other way round: image bytes behind a non-image extension (.txt, .pdf).
    if (type && !type.startsWith('image/') && sniffImageMime(bytes)) {
      type = false;
      ext = false;
    }
    if (!type || !ext) return { error: 'Sorry, you are not allowed to upload this file type.' };

    const date = now();
    const subdir = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    let file = uniqueName(subdir, sanitizeFileName(properName));
    const dirUrl = `${pub()}/wp-content/uploads/${subdir}`;
    const size = imageSize(bytes) || { width: 0, height: 0 };
    const base = file.replace(/\.[^.]+$/, '');
    const fext = file.slice(base.length);
    state.files.set(`${subdir}/${file}`, { bytes, mime: type });

    // big_image_size_threshold (2560): the scaled copy becomes the attachment file.
    let width = size.width;
    let height = size.height;
    let original_image;
    if (width > 2560 || height > 2560) {
      const [sw, sh] = fitSize(width, height, 2560, 2560);
      original_image = file;
      file = `${base}-scaled${fext}`;
      width = sw;
      height = sh;
      state.files.set(`${subdir}/${file}`, { bytes, mime: type });
    }
    const sizes = [];
    for (const [sname, sw, sh, crop] of SUB_SIZES) {
      let dims;
      if (crop) dims = size.width > sw || size.height > sh ? [Math.min(sw, size.width), Math.min(sh, size.height)] : null;
      else dims = fitSize(size.width, size.height, sw, sh);
      if (!dims) continue;
      const sf = `${base}-${dims[0]}x${dims[1]}${fext}`;
      state.files.set(`${subdir}/${sf}`, { bytes, mime: type });
      sizes.push({ name: sname, file: sf, width: dims[0], height: dims[1], filesize: bytes.length });
    }

    const id = state.nextId++;
    const titleFromName = (mode === 'multipart' && originalName && originalName.includes('.') ? originalName.slice(0, originalName.lastIndexOf('.')) : null) || (original_image || file).replace(/\.[^.]+$/, '');
    const canHtml = can(user, 'unfiltered_html');
    const str = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.raw === 'string' ? v.raw : undefined);
    const a = {
      id,
      date,
      modified: date,
      author: user.id,
      subdir,
      dirUrl,
      file,
      original_image,
      width,
      height,
      sizes,
      filesize: bytes.length,
      mime_type: type,
      guid: `${dirUrl}/${original_image || file}`,
      source_url: `${dirUrl}/${file}`,
      slug: slugify(titleFromName) || String(id),
      title: str(query.title) !== undefined ? (canHtml ? str(query.title) : kses(str(query.title), 'title')).trim() : titleFromName,
      caption: str(query.caption) !== undefined ? (canHtml ? str(query.caption) : kses(str(query.caption))) : '',
      description: str(query.description) !== undefined ? (canHtml ? str(query.description) : kses(str(query.description))) : '',
      alt_text: query.alt_text !== undefined ? sanitizeTextField(query.alt_text) : '',
      post: query.post ? Number(query.post) : null,
      // what the mock received, for assertions
      upload: {
        mode,
        filename_header: name,
        original_name: originalName,
        content_type_header: contentType,
        content_md5: ctx.headers['content-md5'],
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sniffed_mime: sniffImageMime(bytes) || null,
        renamed_extension: properName !== name,
      },
      bytes,
    };
    state.media.set(id, a);
    return { attachment: a };
  }

  async function createMedia(ctx, user) {
    const { headers } = ctx;
    // P::create_item_permissions_check for the attachment type (create_posts = upload_files).
    if (!can(user, 'upload_files')) return ctx.respond(ERRORS.rest_cannot_create(user ? 403 : 401));
    const ct = headers['content-type'] || '';
    const md5 = headers['content-md5'];
    let result;
    if (/^multipart\/form-data/i.test(ct)) {
      // A::upload_from_file: PHP fills $_FILES; only the "file" field is used.
      const parts = parseMultipart(ctx.rawBuffer, ct) || [];
      const files = parts.filter((p) => p.filename !== undefined);
      if (!files.length) return ctx.respond(ERRORS.rest_upload_no_data());
      const f = files.find((p) => p.name === 'file');
      if (md5 && f && md5.trim() !== crypto.createHash('md5').update(f.data).digest('hex')) return ctx.respond(ERRORS.rest_upload_hash_mismatch());
      if (!f) return ctx.respond(ERRORS.rest_upload_unknown_error(500, 'Specified file failed upload test.'));
      const query = { ...ctx.query };
      for (const p of parts) if (p.filename === undefined && p.name) query[p.name] = p.data.toString('utf8');
      ctx.entry.body = { multipart: parts.map((p) => ({ name: p.name, filename: p.filename, type: p.type, bytes: p.data.length })) };
      result = storeUpload(ctx, user, { bytes: f.data, name: f.filename, originalName: f.filename, contentType: f.type, mode: 'multipart', query });
      if (result.error) return ctx.respond(ERRORS.rest_upload_unknown_error(500, result.error));
    } else {
      // A::upload_from_data
      const data = ctx.rawBuffer;
      if (!data.length) return ctx.respond(ERRORS.rest_upload_no_data());
      if (!ct) return ctx.respond(ERRORS.rest_upload_no_content_type());
      const cd = headers['content-disposition'];
      if (!cd) return ctx.respond(ERRORS.rest_upload_no_content_disposition());
      const filename = getFilenameFromDisposition([cd]);
      if (!filename) return ctx.respond(ERRORS.rest_upload_invalid_disposition());
      if (md5 && md5.trim() !== crypto.createHash('md5').update(data).digest('hex')) return ctx.respond(ERRORS.rest_upload_hash_mismatch());
      result = storeUpload(ctx, user, { bytes: data, name: filename, contentType: ct, mode: 'raw', query: ctx.query });
      if (result.error) return ctx.respond(ERRORS.rest_upload_sideload_error(500, result.error));
    }
    const a = result.attachment;
    ctx.entry.created = { media_id: a.id, file: `${a.subdir}/${a.file}`, mime_type: a.mime_type, bytes: a.filesize };
    const location = `${pub()}/wp-json/wp/v2/media/${a.id}`;
    return ctx.respond({ status: 201, json: mediaJson(a), headers: { ...WP_HEADERS, location, 'x-wp-upload-attachment-id': String(a.id), allow: 'GET, POST, PUT, PATCH, DELETE' } });
  }

  function requestParams(ctx) {
    const ct = ctx.headers['content-type'] || '';
    const params = { ...ctx.query };
    if (/json/i.test(ct) && ctx.rawBody) {
      let parsed;
      try {
        parsed = JSON.parse(ctx.rawBody);
      } catch {
        return { error: ERRORS.rest_invalid_json() };
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) Object.assign(params, parsed);
    } else if (/x-www-form-urlencoded/i.test(ct) && ctx.rawBody) {
      for (const [k, v] of new URLSearchParams(ctx.rawBody)) params[k] = v;
    }
    return { params };
  }

  function updateMedia(ctx, user, id) {
    const a = state.media.get(id);
    if (!a) return ctx.respond(ERRORS.rest_post_invalid_id());
    // P::update_item_permissions_check: edit_post on the attachment (own uploads for authors).
    if (!user || !can(user, 'upload_files') || (a.author !== user.id && !can(user, 'edit_others_posts'))) {
      return ctx.respond(ERRORS.rest_cannot_edit(user ? 403 : 401));
    }
    const { params, error } = requestParams(ctx);
    if (error) return ctx.respond(error);
    const canHtml = can(user, 'unfiltered_html');
    const str = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.raw === 'string' ? v.raw : undefined);
    for (const k of ['title', 'caption', 'description']) {
      const v = params[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' && (typeof v !== 'object' || Array.isArray(v))) return ctx.respond(invalidParam(k, `${k} is not of type object.`));
    }
    if (params.alt_text !== undefined && params.alt_text !== null && typeof params.alt_text !== 'string') {
      return ctx.respond(invalidParam('alt_text', 'alt_text is not of type string.'));
    }
    const changed = [];
    const t = str(params.title);
    if (t !== undefined) {
      a.title = (canHtml ? t : kses(t, 'title')).trim();
      changed.push('title');
    }
    const c = str(params.caption);
    if (c !== undefined) {
      a.caption = canHtml ? c : kses(c);
      changed.push('caption');
    }
    const d = str(params.description);
    if (d !== undefined) {
      a.description = canHtml ? d : kses(d);
      changed.push('description');
    }
    if (typeof params.alt_text === 'string') {
      a.alt_text = sanitizeTextField(params.alt_text);
      changed.push('alt_text');
    }
    if (params.post !== undefined && params.post !== null) {
      a.post = Number(params.post) || null;
      changed.push('post');
    }
    a.modified = now();
    ctx.entry.updated = { media_id: id, fields: changed };
    return ctx.respond({ status: 200, json: mediaJson(a), headers: { ...WP_HEADERS, allow: 'GET, POST, PUT, PATCH, DELETE' } });
  }

  // ---- posts --------------------------------------------------------------------------------

  function postJson(p) {
    const meta = { footnotes: '' };
    for (const k of registeredMeta) if (Object.hasOwn(p.received_meta || {}, k)) meta[k] = p.received_meta[k];
    return {
      id: p.id,
      date: iso(p.date),
      date_gmt: null,
      guid: { rendered: `${pub()}/?p=${p.id}`, raw: `${pub()}/?p=${p.id}` },
      modified: iso(p.date),
      modified_gmt: iso(p.date),
      password: '',
      slug: p.status === 'draft' && !p.slug_given ? '' : p.slug,
      status: p.status,
      type: 'post',
      link: `${pub()}/?p=${p.id}`,
      title: { raw: p.title, rendered: p.title },
      content: { raw: p.content, rendered: p.content, protected: false, block_version: /<!-- wp:/.test(p.content) ? 1 : 0 },
      excerpt: { raw: p.excerpt, rendered: rendered(p.excerpt), protected: false },
      author: p.author,
      featured_media: p.featured_media,
      comment_status: 'open',
      ping_status: 'open',
      sticky: false,
      template: '',
      format: 'standard',
      meta,
      categories: p.categories,
      tags: p.tags,
      class_list: [`post-${p.id}`, 'post', 'type-post', `status-${p.status}`, 'format-standard', 'hentry'],
      permalink_template: `${pub()}/%postname%/`,
      generated_slug: p.slug,
      _links: {
        self: [{ href: `${pub()}/wp-json/wp/v2/posts/${p.id}` }],
        ...(p.featured_media ? { 'wp:featuredmedia': [{ embeddable: true, href: `${pub()}/wp-json/wp/v2/media/${p.featured_media}` }] } : {}),
      },
    };
  }

  function createPost(ctx, user) {
    if (!can(user, 'edit_posts')) return ctx.respond(ERRORS.rest_cannot_create(user ? 403 : 401));
    const { params, error } = requestParams(ctx);
    if (error) return ctx.respond(error);
    // RQ::has_valid_params against the schema (only the fields the workflow sends).
    for (const k of ['title', 'content', 'excerpt']) {
      const v = params[k];
      if (v !== undefined && v !== null && typeof v !== 'string' && (typeof v !== 'object' || Array.isArray(v))) {
        return ctx.respond(invalidParam(k, `${k} is not of type object.`));
      }
    }
    if (params.status !== undefined && params.status !== null && !['publish', 'future', 'draft', 'pending', 'private'].includes(params.status)) {
      return ctx.respond(invalidParam('status', 'status is not one of publish, future, draft, pending, and private.'));
    }
    if (params.featured_media !== undefined && params.featured_media !== null && !isRestInteger(params.featured_media)) {
      return ctx.respond(invalidParam('featured_media', 'featured_media is not of type integer.'));
    }
    for (const k of ['categories', 'tags']) {
      const v = params[k];
      if (v === undefined || v === null) continue;
      const list = Array.isArray(v) ? v : String(v).split(/[\s,]+/).filter(Boolean);
      if (!list.every(isRestInteger)) return ctx.respond(invalidParam(k, `${k}[0] is not of type integer.`));
    }
    if (params.meta !== undefined && params.meta !== null && (typeof params.meta !== 'object' || Array.isArray(params.meta))) {
      return ctx.respond(invalidParam('meta', 'meta is not of type object.'));
    }
    if (params.status === 'publish' && !can(user, 'publish_posts')) {
      return ctx.respond(wpError('rest_cannot_publish', 'Sorry, you are not allowed to publish posts in this post type.', 403));
    }
    const str = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.raw === 'string' ? v.raw : '');
    const canHtml = can(user, 'unfiltered_html');
    const status = params.status || 'draft';
    const title = str(params.title);
    let slug = slugify(params.slug ?? title);
    if (slug) {
      const used = new Set([...state.posts.values()].map((p) => p.slug));
      if (used.has(slug)) {
        let n = 2;
        while (used.has(`${slug}-${n}`)) n++;
        slug = `${slug}-${n}`;
      }
    }
    const id = state.nextId++;
    const p = {
      id,
      date: now(),
      author: user.id,
      status,
      slug,
      slug_given: params.slug !== undefined,
      title: canHtml ? title.trim() : kses(title, 'title').trim(),
      content: canHtml ? str(params.content) : kses(str(params.content)),
      excerpt: canHtml ? str(params.excerpt) : kses(str(params.excerpt)),
      categories: (Array.isArray(params.categories) ? params.categories : params.categories ? [params.categories] : [1]).map(Number),
      tags: (Array.isArray(params.tags) ? params.tags : params.tags ? [params.tags] : []).map(Number),
      received_meta: params.meta || {},
      received_featured_media: Object.hasOwn(params, 'featured_media') ? params.featured_media : '(absent)',
      featured_media: 0,
      featured_media_result: 'absent',
    };
    // P::create_item -> P::handle_featured_media (its WP_Error is ignored on create) -> set_post_thumbnail
    if (params.featured_media !== undefined && params.featured_media !== null) {
      const fm = Math.abs(Math.trunc(Number(params.featured_media)));
      if (!fm) p.featured_media_result = 'zero';
      else if (!thumbnailSupport) p.featured_media_result = 'ignored:no_thumbnail_support';
      else if (state.media.has(fm)) {
        p.featured_media = fm;
        p.featured_media_result = 'set';
      } else p.featured_media_result = 'ignored:rest_invalid_featured_media';
    }
    state.posts.set(id, p);
    ctx.entry.created = { post_id: id, featured_media: p.featured_media, featured_media_result: p.featured_media_result };
    return ctx.respond({ status: 201, json: postJson(p), headers: { ...WP_HEADERS, location: `${pub()}/wp-json/wp/v2/posts/${id}`, allow: 'GET, POST, PUT, PATCH, DELETE' } });
  }

  // ---- routing ------------------------------------------------------------------------------

  function routeOf(method, pathname) {
    let m;
    if (pathname === '/wp-json/wp/v2/media' || pathname === '/wp-json/wp/v2/media/') return method === 'POST' ? ['media.create'] : ['media.list'];
    if ((m = /^\/wp-json\/wp\/v2\/media\/(\d+)\/?$/.exec(pathname))) {
      if (['POST', 'PUT', 'PATCH'].includes(method)) return ['media.update', Number(m[1])];
      if (method === 'GET') return ['media.get', Number(m[1])];
    }
    if (pathname === '/wp-json/wp/v2/posts' || pathname === '/wp-json/wp/v2/posts/') return method === 'POST' ? ['posts.create'] : ['posts.list'];
    if ((m = /^\/wp-json\/wp\/v2\/posts\/(\d+)\/?$/.exec(pathname)) && method === 'GET') return ['posts.get', Number(m[1])];
    if (/^\/wp-json\/wp\/v2\/users(\/me)?\/?$/.test(pathname) && method === 'GET') return ['users', pathname.includes('/me')];
    if (pathname.startsWith('/wp-content/uploads/') && (method === 'GET' || method === 'HEAD')) return ['uploads'];
    if (pathname.startsWith('/wp-json')) return ['no_route'];
    return ['not_found'];
  }

  function publicState() {
    const strip = ({ bytes, dirUrl, ...rest }) => ({ ...rest, date: iso(rest.date), modified: iso(rest.modified) });
    return {
      media: [...state.media.values()].map(strip),
      posts: [...state.posts.values()].map((p) => ({ ...p, date: iso(p.date) })),
      files: [...state.files.keys()],
    };
  }

  return startHttpMock({
    name: 'wordpress',
    port: opts.port,
    host: opts.host,
    logFile: opts.logFile,
    quiet: opts.quiet,
    fixtures: {},
    async handle(ctx) {
      const { req, res, pathname, headers, entry } = ctx;
      const method = req.method;
      // Binary bodies are logged as a summary, never as text.
      const ct = headers['content-type'] || '';
      if (ctx.rawBuffer.length && !/json|x-www-form-urlencoded|^text\//i.test(ct)) {
        entry.body = {
          bytes: ctx.rawBuffer.length,
          sha256: crypto.createHash('sha256').update(ctx.rawBuffer).digest('hex'),
          head_hex: ctx.rawBuffer.subarray(0, 8).toString('hex'),
        };
      }
      entry.body_bytes = ctx.rawBuffer.length;

      if (pathname === '/__mock/state' && method === 'GET') return sendJson(res, 200, publicState());
      if (pathname === '/__mock/errors' && method === 'POST') {
        errorsOverride = ctx.rawBody ? JSON.parse(ctx.rawBody) : {};
        hits.clear();
        return sendJson(res, 200, { ok: true, errors: errorsOverride });
      }
      if (pathname === '/__mock/reset-state' && method === 'POST') {
        state.media.clear();
        state.posts.clear();
        state.files.clear();
        state.nextId = opts.firstId ?? 1001;
        hits.clear();
        return sendJson(res, 200, { ok: true });
      }

      // nginx client_max_body_size
      if (opts.maxBodyBytes && ctx.rawBuffer.length > opts.maxBodyBytes) {
        entry.route = 'nginx';
        return ctx.respond(nginxPage(413, 'Request Entity Too Large'));
      }

      const [route, arg] = routeOf(method, pathname);
      entry.route = route;
      const inj = injected(route);
      if (inj) {
        entry.injected = true;
        return ctx.respond(inj);
      }

      if (route === 'uploads') {
        const f = state.files.get(decodeURIComponent(pathname.slice('/wp-content/uploads/'.length)));
        if (!f) return ctx.respond(nginxPage(404, 'Not Found'));
        return ctx.respond({ status: 200, raw: f.bytes, contentType: f.mime });
      }
      if (route === 'not_found') return ctx.respond(nginxPage(404, 'Not Found'));

      // rest_authentication_errors runs before routing (WP_REST_Server::serve_request).
      const auth = authenticate(headers);
      if (auth.error) return ctx.respond(auth.error);
      const user = auth.user;
      entry.user = user ? user.login : null;

      switch (route) {
        case 'media.create':
          return createMedia(ctx, user);
        case 'media.update':
          return updateMedia(ctx, user, arg);
        case 'media.get': {
          const a = state.media.get(arg);
          if (!a) return ctx.respond(ERRORS.rest_post_invalid_id());
          return ctx.respond({ status: 200, json: mediaJson(a), headers: WP_HEADERS });
        }
        case 'posts.create':
          return createPost(ctx, user);
        case 'posts.get': {
          const p = state.posts.get(arg);
          if (!p || (!user && p.status !== 'publish')) return ctx.respond(user ? ERRORS.rest_post_invalid_id() : wpError('rest_forbidden', 'Sorry, you are not allowed to do that.', 401));
          return ctx.respond({ status: 200, json: postJson(p), headers: WP_HEADERS });
        }
        case 'users':
          if (arg) {
            if (!user) return ctx.respond(wpError('rest_not_logged_in', 'You are not currently logged in.', 401));
            return ctx.respond({ status: 200, json: userJson(user), headers: WP_HEADERS });
          }
          return ctx.respond({ status: 200, json: user ? [userJson(user)] : [], headers: { ...WP_HEADERS, 'x-wp-total': user ? '1' : '0', 'x-wp-totalpages': '1' } });
        case 'media.list':
        case 'posts.list':
          return ctx.respond({ status: 200, json: [], headers: { ...WP_HEADERS, 'x-wp-total': '0', 'x-wp-totalpages': '0' } });
        default:
          return ctx.respond(ERRORS.rest_no_route());
      }
    },
  }).then((mock) => {
    baseUrl = mock.url;
    return {
      ...mock,
      /** Live state: {media: Map, posts: Map}. Stored attachments keep their `bytes` Buffer. */
      state,
      publicState,
      setErrors(map) {
        errorsOverride = map || {};
        hits.clear();
      },
      credential: () => CREDENTIAL(mock.url),
    };
  });
}

const isMain =
  !process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mock = await startWordpressMock({
    port: Number(cliArg('port') ?? process.env.MOCK_WORDPRESS_PORT ?? PREFERRED_PORT),
    errors: cliArg('errors') ?? process.env.MOCK_WORDPRESS_ERRORS,
    logFile: cliArg('log') ?? process.env.MOCK_WORDPRESS_LOG,
  });
  process.stdout.write(`MOCK_WORDPRESS_LISTENING ${mock.url}\n`);
  const stop = () => mock.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
