import { expect, test } from '@rstest/core'
import { escapeHtml, renderLoginPage } from '../../src/page.js'

test('escapeHtml neutralizes every HTML-significant character', () => {
  expect(escapeHtml(`<script>alert("x" + 'y')</script> & more`)).toBe(
    '&lt;script&gt;alert(&quot;x&quot; + &#39;y&#39;)&lt;/script&gt; &amp; more',
  )
})

test('escapeHtml escapes ampersands first, so entities are not double-decoded', () => {
  // '&lt;' arriving as literal text must survive as '&amp;lt;', not '&lt;'.
  expect(escapeHtml('&lt;')).toBe('&amp;lt;')
})

test('escapeHtml coerces non-strings', () => {
  // The parameter is `unknown`: an operator-supplied title comes out of a YAML
  // profile, where `title: 2024` is a number and an omitted key is undefined.
  expect(escapeHtml(42)).toBe('42')
  expect(escapeHtml(undefined)).toBe('undefined')
  expect(escapeHtml(null)).toBe('null')
})

test('the page is a complete standalone document', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(html).toMatch(/^<!doctype html>/)
  expect(html).toMatch(/<\/html>\s*$/)
  expect(html).toMatch(/<meta charset="utf-8">/)
  expect(html).toMatch(/<meta name="viewport"/)
  // Indexing a login page serves nobody.
  expect(html).toMatch(/<meta name="robots" content="noindex, nofollow">/)
})

test('the page fetches nothing, which is what lets the CSP be default-src none', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(/<script/i.test(html), 'no scripts').toBe(false)
  expect(/<link/i.test(html), 'no external stylesheets').toBe(false)
  expect(/<img/i.test(html), 'no images').toBe(false)
  expect(/https?:\/\//i.test(html), 'no absolute URLs').toBe(false)
})

test('the form posts the password back to /login', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(html).toMatch(/<form method="post" action="\/login">/)
  expect(html).toMatch(/name="password" type="password"/)
  expect(html).toMatch(/autocomplete="current-password"/)
})

test('github mode links to the OAuth start path without scripts', () => {
  const html = renderLoginPage({ title: 'DSH Web', mode: 'github' })
  expect(html).toMatch(/href="\/auth\/github\/login"/)
  expect(html).toMatch(/Continue with GitHub/)
  expect(/<script/i.test(html)).toBe(false)
})

test('enroll mode posts to the bind endpoint', () => {
  const html = renderLoginPage({ title: 'DSH Web', mode: 'enroll' })
  expect(html).toMatch(/<form method="post" action="\/auth\/github\/enroll">/)
  expect(html).toMatch(/Bind GitHub account/)
})

test('maintenance mode has no interactive form', () => {
  const html = renderLoginPage({ title: 'DSH Web', mode: 'maintenance' })
  expect(html.includes('<form')).toBe(false)
  expect(html).toMatch(/temporarily unavailable/)
})

test('the title is interpolated into both the head and the heading', () => {
  const html = renderLoginPage({ title: 'My Shell' })
  expect(html).toMatch(/<title>Sign in · My Shell<\/title>/)
  expect(html).toMatch(/<h1>My Shell<\/h1>/)
})

test('a hostile title cannot break out of the document', () => {
  const html = renderLoginPage({ title: '</title><script>steal()</script>' })
  expect(html.includes('<script>steal()'), 'the injected tag must be escaped').toBe(false)
  expect(html).toMatch(/&lt;script&gt;steal\(\)&lt;\/script&gt;/)
})

test('no message means no banner', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(html.includes('class="error"')).toBe(false)
  expect(html.includes('role="alert"')).toBe(false)
})

test('a message renders as an alert and is escaped', () => {
  const html = renderLoginPage({ title: 'DSH Web', message: 'Incorrect <password>' })
  expect(html).toMatch(/<p class="error" role="alert">Incorrect &lt;password&gt;<\/p>/)
})

test('the page carries no vendor branding', () => {
  // The prototype this grew from shipped a "dsh" badge and a CJK webfont entry
  // borrowed from another product's shell; a published package should not.
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(html.includes('class="mark"')).toBe(false)
  expect(html.includes('Noto Sans SC')).toBe(false)
})

test('the page explains that sessions do not survive a restart', () => {
  expect(renderLoginPage({ title: 'DSH Web' })).toMatch(/end when the server restarts/)
})

test('the page honours both color schemes', () => {
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(html).toMatch(/color-scheme: light dark/)
  expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/)
})

test('the illustration is inline markup, and motion yields to a preference', () => {
  // Both are properties of the redesign that the CSP depends on: an inline
  // <svg> is markup rather than a fetch, so it costs `default-src 'none'`
  // nothing, and an entrance animation that cannot be turned off is an
  // accessibility regression a login page has no excuse for.
  const html = renderLoginPage({ title: 'DSH Web' })
  expect(html).toMatch(/<svg viewBox="0 0 24 24"/)
  expect(html).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
})
