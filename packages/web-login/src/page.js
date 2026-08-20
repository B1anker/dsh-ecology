/**
 * The login page markup.
 *
 * Self-contained by necessity: this page is served before authentication, so it
 * cannot pull anything from `/plugins` or `/api` (both sit behind the gate), and
 * it must not depend on the SPA bundle at all. Everything is inline, which is
 * also what lets the response carry a `default-src 'none'` policy — no scripts,
 * no fonts, no images fetched from anywhere.
 *
 * The visual language is deliberately neutral rather than an imitation of any
 * vendor's shell: one accent, generous negative space, a single centered card,
 * and `prefers-color-scheme` honoured so the page does not flash white against
 * a dark desktop.
 *
 * @module @seaveyon/dsh-web-login/page
 */

/**
 * Escape text for interpolation into HTML.
 *
 * The title is operator-supplied and the message is chosen from a fixed set, so
 * neither is attacker-controlled today — but both land in a document served
 * without authentication, and the escape costs nothing.
 *
 * @param value - untrusted text.
 * @returns the text with HTML-significant characters replaced.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Render the sign-in page.
 * @param options - the page title, and an optional message shown above the form.
 * @returns a complete HTML document.
 */
export function renderLoginPage({ title, message = '' }) {
  const safeTitle = escapeHtml(title)
  const banner = message === ''
    ? ''
    : `    <p class="error" role="alert">${escapeHtml(message)}</p>\n`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · ${safeTitle}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --bg-elevated: #ffffff;
    --fg: #14161a;
    --fg-muted: #6b7280;
    --border: #e2e5ea;
    --border-strong: #cdd2da;
    --accent: #4f46e5;
    --accent-fg: #ffffff;
    --danger: #b42318;
    --danger-bg: #fef3f2;
    --danger-border: #fda29b;
    --ring: rgba(79, 70, 229, 0.16);
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.04), 0 12px 32px -12px rgba(16, 24, 40, 0.16);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d10;
      --bg-elevated: #14171c;
      --fg: #f2f4f7;
      --fg-muted: #98a2b3;
      --border: #23272f;
      --border-strong: #333945;
      --accent: #7c74f4;
      --accent-fg: #0b0d10;
      --danger: #fda29b;
      --danger-bg: #2a1512;
      --danger-border: #6b2a24;
      --ring: rgba(124, 116, 244, 0.22);
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 16px 40px -12px rgba(0, 0, 0, 0.6);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg);
    color: var(--fg);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 380px;
    padding: 32px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg-elevated);
    box-shadow: var(--shadow);
  }
  h1 {
    margin: 0 0 6px;
    font-size: 19px;
    font-weight: 620;
    letter-spacing: -0.011em;
  }
  .sub {
    margin: 0 0 24px;
    color: var(--fg-muted);
    font-size: 13.5px;
  }
  label {
    display: block;
    margin-bottom: 7px;
    font-size: 13px;
    font-weight: 540;
  }
  input[type="password"] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type="password"]:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3.5px var(--ring);
  }
  button {
    width: 100%;
    margin-top: 18px;
    padding: 10px 14px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: var(--accent);
    color: var(--accent-fg);
    font: inherit;
    font-weight: 560;
    cursor: pointer;
    transition: filter .15s, transform .06s;
  }
  button:hover { filter: brightness(1.07); }
  button:active { transform: translateY(0.5px); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--ring); }
  .error {
    margin: 0 0 18px;
    padding: 9px 12px;
    border: 1px solid var(--danger-border);
    border-radius: 9px;
    background: var(--danger-bg);
    color: var(--danger);
    font-size: 13px;
  }
  .foot {
    margin: 22px 0 0;
    color: var(--fg-muted);
    font-size: 12px;
    text-align: center;
  }
</style>
</head>
<body>
  <main class="card">
    <h1>${safeTitle}</h1>
    <p class="sub">Enter the access password to continue.</p>
${banner}    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password"
             required autofocus spellcheck="false">
      <button type="submit">Sign in</button>
    </form>
    <p class="foot">Sessions are held in memory and end when the server restarts.</p>
  </main>
</body>
</html>
`
}
