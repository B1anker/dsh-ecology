import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeHtml, renderLoginPage } from '../../src/page.js'

test('escapeHtml neutralizes every HTML-significant character', () => {
  assert.equal(
    escapeHtml(`<script>alert("x" + 'y')</script> & more`),
    '&lt;script&gt;alert(&quot;x&quot; + &#39;y&#39;)&lt;/script&gt; &amp; more',
  )
})

test('escapeHtml escapes ampersands first, so entities are not double-decoded', () => {
  // '&lt;' arriving as literal text must survive as '&amp;lt;', not '&lt;'.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;')
})

test('escapeHtml coerces non-strings', () => {
  assert.equal(escapeHtml(42), '42')
  assert.equal(escapeHtml(undefined), 'undefined')
  assert.equal(escapeHtml(null), 'null')
})

test('the page is a complete standalone document', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<\/html>\s*$/)
  assert.match(html, /<meta charset="utf-8">/)
  assert.match(html, /<meta name="viewport"/)
  // Indexing a login page serves nobody.
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/)
})

test('the page fetches nothing, which is what lets the CSP be default-src none', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  assert.ok(!/<script/i.test(html), 'no scripts')
  assert.ok(!/<link/i.test(html), 'no external stylesheets')
  assert.ok(!/<img/i.test(html), 'no images')
  assert.ok(!/https?:\/\//i.test(html), 'no absolute URLs')
})

test('the form posts the password back to /login', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  assert.match(html, /<form method="post" action="\/login">/)
  assert.match(html, /name="password" type="password"/)
  assert.match(html, /autocomplete="current-password"/)
})

test('the title is interpolated into both the head and the heading', () => {
  const html = renderLoginPage({ title: 'My Shell' })
  assert.match(html, /<title>Sign in · My Shell<\/title>/)
  assert.match(html, /<h1>My Shell<\/h1>/)
})

test('a hostile title cannot break out of the document', () => {
  const html = renderLoginPage({ title: '</title><script>steal()</script>' })
  assert.ok(!html.includes('<script>steal()'), 'the injected tag must be escaped')
  assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/)
})

test('no message means no banner', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  assert.ok(!html.includes('class="error"'))
  assert.ok(!html.includes('role="alert"'))
})

test('a message renders as an alert and is escaped', () => {
  const html = renderLoginPage({ title: 'DSH Web', message: 'Incorrect <password>' })
  assert.match(html, /<p class="error" role="alert">Incorrect &lt;password&gt;<\/p>/)
})

test('the page carries no vendor branding', () => {
  // The prototype this grew from shipped a "dsh" badge and a CJK webfont entry
  // borrowed from another product's shell; a published package should not.
  const html = renderLoginPage({ title: 'DSH Web' })
  assert.ok(!html.includes('class="mark"'))
  assert.ok(!html.includes('Noto Sans SC'))
})

test('the page explains that sessions do not survive a restart', () => {
  assert.match(renderLoginPage({ title: 'DSH Web' }), /end when the server restarts/)
})

test('the page honours both color schemes', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  assert.match(html, /color-scheme: light dark/)
  assert.match(html, /@media \(prefers-color-scheme: dark\)/)
})
