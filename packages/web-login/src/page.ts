/**
 * The login page markup.
 *
 * Self-contained by necessity: this page is served before authentication, so it
 * cannot pull anything from `/plugins` or `/api` (both sit behind the gate), and
 * it must not depend on the SPA bundle at all. Everything is inline, which is
 * also what lets the response carry a `default-src 'none'` policy — no scripts,
 * no fonts, no images fetched from anywhere. The one illustration is an inline
 * `<svg>`, which is markup rather than a fetch, so it costs the policy nothing.
 *
 * The visual language is deliberately neutral rather than an imitation of any
 * vendor's shell: one accent, generous negative space, a single centered card
 * floating over a soft aurora wash, and `prefers-color-scheme` honoured so the
 * page does not flash white against a dark desktop. Motion is limited to one
 * entrance transition and yields to `prefers-reduced-motion`.
 *
 * There is no JavaScript, so every interactive affordance here — focus rings,
 * the hover lift, the lock glyph — is CSS or markup only. That constraint is the
 * point: a sign-in page that needs a bundle to render is a sign-in page that can
 * fail to render.
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
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Which sign-in affordance the page should present. */
export type LoginPageMode = 'password' | 'github' | 'choice' | 'enroll' | 'maintenance'

/** What the page needs in order to render. */
export interface LoginPageOptions {
  /** Shown in the document title and as the heading. */
  title: string
  /** Optional alert above the form; empty means no banner is rendered. */
  message?: string
  /** Which primary action to show. Defaults to the password form. */
  mode?: LoginPageMode
}

/**
 * Shared stylesheet for every login-page mode.
 * @returns the CSS embedded in the document head.
 */
function styles(): string {
  return `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --bg-elevated: rgba(255, 255, 255, 0.86);
    --fg: #10131a;
    --fg-muted: #626b7b;
    --fg-subtle: #8b93a3;
    --border: rgba(16, 24, 40, 0.09);
    --border-strong: rgba(16, 24, 40, 0.16);
    --field-bg: rgba(255, 255, 255, 0.72);
    --accent: #5b53f0;
    --accent-hover: #6a62f7;
    --accent-fg: #ffffff;
    --danger: #b42318;
    --danger-bg: rgba(254, 243, 242, 0.9);
    --danger-border: rgba(217, 45, 32, 0.28);
    --ring: rgba(91, 83, 240, 0.18);
    --glow-a: rgba(99, 102, 241, 0.30);
    --glow-b: rgba(56, 189, 248, 0.22);
    --glow-c: rgba(168, 85, 247, 0.18);
    --card-shadow:
      0 1px 2px rgba(16, 24, 40, 0.04),
      0 8px 20px -8px rgba(16, 24, 40, 0.10),
      0 28px 56px -20px rgba(16, 24, 40, 0.18);
    --hairline: rgba(255, 255, 255, 0.7);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #070809;
      --bg-elevated: rgba(21, 24, 30, 0.82);
      --fg: #f3f5f8;
      --fg-muted: #9aa3b2;
      --fg-subtle: #6d7686;
      --border: rgba(255, 255, 255, 0.09);
      --border-strong: rgba(255, 255, 255, 0.16);
      --field-bg: rgba(255, 255, 255, 0.04);
      --accent: #7d76f8;
      --accent-hover: #8d86ff;
      --accent-fg: #0a0b0f;
      --danger: #fda29b;
      --danger-bg: rgba(66, 26, 22, 0.66);
      --danger-border: rgba(253, 162, 155, 0.26);
      --ring: rgba(125, 118, 248, 0.28);
      --glow-a: rgba(99, 102, 241, 0.26);
      --glow-b: rgba(34, 211, 238, 0.16);
      --glow-c: rgba(168, 85, 247, 0.20);
      --card-shadow:
        0 1px 2px rgba(0, 0, 0, 0.5),
        0 10px 24px -10px rgba(0, 0, 0, 0.6),
        0 32px 64px -24px rgba(0, 0, 0, 0.8);
      --hairline: rgba(255, 255, 255, 0.10);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background-color: var(--bg);
    color: var(--fg);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body::before {
    content: "";
    position: fixed;
    inset: -25%;
    z-index: -1;
    pointer-events: none;
    background:
      radial-gradient(42% 38% at 18% 12%, var(--glow-a), transparent 68%),
      radial-gradient(38% 34% at 84% 22%, var(--glow-b), transparent 66%),
      radial-gradient(46% 42% at 62% 92%, var(--glow-c), transparent 70%);
    filter: blur(8px);
  }
  .card {
    position: relative;
    width: 100%;
    max-width: 396px;
    padding: 38px 34px 30px;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--bg-elevated);
    box-shadow: var(--card-shadow);
    backdrop-filter: blur(14px) saturate(150%);
    -webkit-backdrop-filter: blur(14px) saturate(150%);
    animation: rise .5s cubic-bezier(.22, 1, .36, 1) both;
  }
  .card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 1px;
    border-radius: 18px 18px 0 0;
    background: linear-gradient(90deg, transparent, var(--hairline) 22%, var(--hairline) 78%, transparent);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px) scale(.985); }
    to   { opacity: 1; transform: none; }
  }
  .badge {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    margin: 0 0 20px;
    border: 1px solid var(--border);
    border-radius: 13px;
    background: linear-gradient(160deg, var(--field-bg), transparent);
    color: var(--accent);
  }
  .badge svg { display: block; width: 22px; height: 22px; }
  h1 {
    margin: 0 0 7px;
    font-size: 21px;
    font-weight: 640;
    letter-spacing: -0.017em;
  }
  .sub {
    margin: 0 0 26px;
    color: var(--fg-muted);
    font-size: 13.5px;
  }
  label {
    display: block;
    margin-bottom: 8px;
    font-size: 12.5px;
    font-weight: 560;
    letter-spacing: -0.003em;
  }
  input[type="password"] {
    width: 100%;
    padding: 11px 13px;
    border: 1px solid var(--border-strong);
    border-radius: 11px;
    background: var(--field-bg);
    color: var(--fg);
    font: inherit;
    letter-spacing: .06em;
    transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
  }
  input[type="password"]::placeholder { color: var(--fg-subtle); letter-spacing: normal; }
  input[type="password"]:hover { border-color: var(--accent); }
  input[type="password"]:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--ring);
  }
  button, .btn {
    display: block;
    width: 100%;
    margin-top: 20px;
    padding: 11px 16px;
    border: 1px solid transparent;
    border-radius: 11px;
    background: var(--accent);
    color: var(--accent-fg);
    font: inherit;
    font-weight: 580;
    letter-spacing: -0.003em;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.10), 0 8px 18px -10px var(--accent);
    transition: background-color .16s ease, transform .08s ease, box-shadow .16s ease;
  }
  button:hover, .btn:hover { background: var(--accent-hover); transform: translateY(-1px); }
  button:active, .btn:active { transform: translateY(0.5px); box-shadow: 0 1px 2px rgba(16, 24, 40, 0.12); }
  button:focus-visible, .btn:focus-visible { outline: none; box-shadow: 0 0 0 4px var(--ring); }
  button.secondary, .btn.secondary {
    margin-top: 12px;
    background: transparent;
    color: var(--fg-muted);
    border-color: var(--border-strong);
    box-shadow: none;
  }
  button.secondary:hover, .btn.secondary:hover {
    background: var(--field-bg);
    color: var(--fg);
    border-color: var(--accent);
  }
  .divider {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    gap: 12px;
    align-items: center;
    margin: 22px 0 2px;
    color: var(--fg-subtle);
    font-size: 11.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .divider::before, .divider::after {
    content: '';
    height: 1px;
    background: var(--border);
  }
  .error {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    margin: 0 0 20px;
    padding: 10px 13px;
    border: 1px solid var(--danger-border);
    border-radius: 11px;
    background: var(--danger-bg);
    color: var(--danger);
    font-size: 13px;
    animation: shake .34s cubic-bezier(.36, .07, .19, .97) both;
  }
  @keyframes shake {
    10%, 90% { transform: translateX(-1px); }
    30%, 70% { transform: translateX(2px); }
    50%      { transform: translateX(-2px); }
  }
  .foot {
    margin: 26px 0 0;
    padding-top: 18px;
    border-top: 1px solid var(--border);
    color: var(--fg-subtle);
    font-size: 11.5px;
    line-height: 1.5;
    text-align: center;
  }
  @media (max-width: 420px) {
    .card { padding: 30px 22px 24px; border-radius: 16px; }
    h1 { font-size: 19px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    button:hover, button:active, .btn:hover, .btn:active { transform: none; }
  }
`
}

/**
 * Render the primary action for the requested mode.
 * @param mode - page mode.
 * @returns HTML for the form or link.
 */
function renderPasswordForm({ autofocus }: { autofocus: boolean }): string {
  const focus = autofocus ? ' autofocus' : ''
  return `    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password"
             placeholder="Access password" required${focus} spellcheck="false">
      <button type="submit">Sign in</button>
    </form>\n`
}

function renderAction(mode: LoginPageMode): { subtitle: string; action: string; foot: string } {
  switch (mode) {
    case 'github':
      return {
        subtitle: 'Sign in with a registered GitHub account to continue.',
        action: `    <a class="btn" href="/auth/github/login">Continue with GitHub</a>\n`,
        foot: 'Only GitHub accounts authorized on this host can enter.',
      }
    case 'choice':
      return {
        subtitle: 'Choose how to sign in.',
        action: `    <a class="btn" href="/auth/github/login">Continue with GitHub</a>
    <p class="divider" aria-hidden="true">or</p>
${renderPasswordForm({ autofocus: false })}`,
        foot: 'GitHub admits registered accounts; the access password still works on this host.',
      }
    case 'enroll':
      return {
        subtitle: 'Bind your GitHub account as the owner of this host, or continue with the password.',
        // GET (not a form POST): CSP form-action 'self' would otherwise block the
        // browser from following the OAuth redirect to github.com.
        action: `    <a class="btn" href="/auth/github/enroll">Bind GitHub account</a>
    <form method="post" action="/auth/continue">
      <button class="secondary" type="submit">Continue without GitHub</button>
    </form>\n`,
        foot: 'You can bind GitHub later; password sign-in stays available either way.',
      }
    case 'maintenance':
      return {
        subtitle: 'This login gate is temporarily unavailable.',
        action: '',
        foot: 'Use the host-local recovery command if you administer this instance.',
      }
    case 'password':
    default:
      return {
        subtitle: 'Enter the access password to continue.',
        action: renderPasswordForm({ autofocus: true }),
        foot: 'Sessions are held in memory and end when the server restarts.',
      }
  }
}

/**
 * Render the sign-in page.
 * @param options - the page title, optional message, and display mode.
 * @returns a complete HTML document.
 */
export function renderLoginPage({
  title,
  message = '',
  mode = 'password',
}: LoginPageOptions): string {
  const safeTitle = escapeHtml(title)
  const banner =
    message === '' ? '' : `    <p class="error" role="alert">${escapeHtml(message)}</p>\n`
  const { subtitle, action, foot } = renderAction(mode)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in · ${safeTitle}</title>
<style>${styles()}
</style>
</head>
<body>
  <main class="card">
    <div class="badge" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
           stroke-linecap="round" stroke-linejoin="round" focusable="false">
        <rect x="4" y="10.5" width="16" height="10.5" rx="3"></rect>
        <path d="M8.2 10.5V7.4a3.8 3.8 0 0 1 7.6 0v3.1"></path>
        <circle cx="12" cy="15.8" r="1.35" fill="currentColor" stroke="none"></circle>
      </svg>
    </div>
    <h1>${safeTitle}</h1>
    <p class="sub">${escapeHtml(subtitle)}</p>
${banner}${action}    <p class="foot">${escapeHtml(foot)}</p>
  </main>
</body>
</html>
`
}

/**
 * HTML bridge after a cross-site GitHub OAuth callback.
 *
 * The session cookie is `SameSite=Strict`. A 302/303 from the GitHub redirect
 * chain often fails to attach that cookie to the follow-up request for `/`, so
 * the operator lands back on `/login` despite a successful callback. Serving a
 * same-origin document first, then navigating to `/` via meta refresh / link,
 * makes the cookie first-party for the home request.
 *
 * @param title - product title shown on the bridge page.
 * @returns a complete HTML document.
 */
export function renderOAuthContinuePage(title: string): string {
  const safeTitle = escapeHtml(title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="0;url=/">
<title>Signed in · ${safeTitle}</title>
<style>${styles()}
</style>
</head>
<body>
  <main class="card">
    <h1>${safeTitle}</h1>
    <p class="sub">Sign-in succeeded. Continuing…</p>
    <a class="btn" href="/">Continue</a>
    <p class="foot">If nothing happens, use the button above.</p>
  </main>
</body>
</html>
`
}
