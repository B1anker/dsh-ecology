# World Line — DSH Web implementation QA

final result: passed

Scope: DSH Web plugin on DSH 0.1.2-rc.1, verified at desktop 1512 × 862 and narrow 390 × 844 CSS viewports. This records the approved concept's implementation in the actual host, not a claim of pixel-identical mock data or exhaustive device certification.

## Visual evidence

- Source: `/Users/seavey/.codex/generated_images/01a0753e-68f1-7232-81b5-728371152351/exec-c2ea1388-482f-487c-9fec-4487d1c57dba.png`
- Source dimensions: 2010 × 782, containing two approximately 986 × 710 app frames plus presentation margins. Generated concept; CSS viewport and device density are not encoded.
- Light: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-light.png`
- Dark: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-dark.png`
- Creation drawer: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-create.png`
- Implementation: Chrome, 1512 × 862 CSS viewport; screenshots 1512 × 862 output pixels. No resampling or alteration of evidence.
- State: `main` source, `test` selected/default/running on 55333, child `ui-preview` stopped on 55225. Themes changed using native DSH Settings; original “follow system” restored.
- Source and final light/dark/drawer screenshots opened together in the same comparison tool input. Judged corresponding page regions with host width differences noted, rather than comparing the whole two-up sheet against one app frame.
- Labels, typography and actions were readable at the displayed image resolution; no extra focused crop needed.

## Comparison history and findings

1. Initial real render showed every historical verification lab. The selected persistent instance fell below the visible graph and long unnamed IDs dominated it (P1). Added a verification-lab toggle, with persistent world lines visible by default. Final captures show all three relevant tracks and the selected instance.
2. Closely spaced timestamps produced backward-curving connectors near the ruler start (P2). Clamped the curve control point; final captures show a continuous forward fork.
3. The canvas reserved excessive vertical space (P2). Reduced reserved graph height and rechecked the visible bottom action bar. Final captures contain all three tracks and the bottom controls.
4. Added actual branch-time annotations and explicit 14px page typography; compared fresh captures in both themes. No remaining actionable desktop P0/P1/P2 findings.

## Required fidelity surfaces

- Typography: inherits DSH's font; 28px title, 14px controls, 16px instance labels, secondary captions. The hierarchy follows the reference without introducing another display font.
- Layout: native sidebar remains 280px at the tested viewport; title, horizontal parallel tracks, branch connectors, selected band, cursor ring and persistent bottom actions retained. The actual public extension slot places navigation beside Settings at the sidebar foot; no workspace/service replacement.
- Colors: native `--dsw-alias-*` surface, label, border, state and primary-button tokens. Selected lines use the host's actual business accent, including runtime theme overrides. Main button reverses from dark to light with native theme.
- Assets: original host logo remains host-rendered. Phosphor library supplies action icons. The canvas is a live data visualization of real creation/fork records, not a replacement raster illustration.
- Copy/data: real aliases, times, ports and states replace demonstration content. Runtime state and verification result are distinct. The cursor explicitly describes viewing only; historical restoration is not implied. The source row is labeled as a source environment, without claiming its process status.

## Functional evidence

- Native DSH loads the module, sidebar action and full management surface; existing workspace and chat UI remain usable after closing it.
- Created `ui-preview` from `test` through the browser; child manifest records `source.parentLabId`.
- Set the child as default, renamed it, and verified default followed the unchanged ID.
- Stopped the child, entered/restarted it, and verified port 55225 was retained; the new tab rendered the DSH shell with the World Line action.
- Restored `test` as default; left it running on 55333. Renamed the child back to `ui-preview` and stopped it.
- Creation dialog opens with the selected source, focuses its input, exposes cancel/submit and shows in-flight state.
- Keyboard Home/ArrowRight/End changes the viewing-time slider.
- Native light/dark switch verified; browser error log contained no errors.
- Build and typecheck pass; 26 test files / 201 tests pass. Added tests for parent data independence, lineage, duplicate aliases, native authentication, same-origin JSON enforcement, cross-profile refusal and self-stop/delete refusal.
- npm dry-run includes client bundle, host entry, API entry and bundle patch.

## Limits / follow-up

- The initial viewport override did not affect the user-owned tab. The polish pass used a new Chrome tab, verified its actual innerWidth was 390, and completed narrow-layout checks described below.
- Real creation times span hours. The polish pass reserves right-edge space for recent forks and the current-time cursor; future zoom/pan can improve very dense histories. Timestamps were not altered to mimic the mock.
- Host-side non-atomic copying of live databases and loopback-only entry URLs remain documented constraints.

## Breathing and interaction polish pass

Final result: passed for the tested states and viewports.

- Running lines have a 3.2-second node breath, expanding rings and a restrained seven-second traveling light. Stopped lines use static dashed tracks. Status dots breathe in both graph and narrow card layouts. Two successive live DOM observations measured opacity changing from 0.658452 to 0.529871 with animation name `wl-breathe`.
- Motion uses a separate canvas at approximately 30 fps without React updates per frame. Code pauses canvas animation when the page is hidden or the graph is outside the viewport, and honors reduced motion. Those lifecycle and preference branches were inspected in code, not independently emulated in the browser.
- Added complete loading, refresh, mutation, success, error/retry and empty-search feedback; abortable refreshes; duplicate-submit prevention; and a clickable entry fallback when a popup is blocked.
- Verified duplicate and reserved aliases prevent submission, a valid alias enables it, and Escape closes the drawer. Destructive confirmation stays disabled until the alias matches; verified the enabled state and canceled without deleting a lab.
- Search for `ui-preview` preserves its `main → test` ancestry. An unmatched search shows a clear empty state, and clearing search restores the graph.
- Menus have semantic roles, keyboard navigation, outside dismissal and focus handling. Verified Escape dismisses the menu while leaving the management page open. Dialogs contain focus and restore it on close.
- Initial 390px testing exposed a stale 280px overlay offset after DSH collapsed its sidebar (P1). Fixed live frame measurement, resize synchronization and the collapsed-sidebar CSS override. Final narrow captures show a 56px host sidebar, readable scrollable lineage cards and a single-row persistent entry/fork/menu action bar. Selected the stopped child and exercised its confirmation drawer at this width.
- Restored the desktop viewport, verified the 280px sidebar offset, captured both native themes and restored “follow system.” Browser error logs were empty. No remaining actionable P0/P1/P2 visual findings in these tested states.
- Rebuilt the plugin and passed typecheck, client lint, whitespace checks and all 201 tests across 26 files after the polish changes.

Final unaltered screenshots, compared together with the selected source image in one tool input:

- Light / first breathing frame: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-breath-a.png`
- Second breathing frame: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-breath-b.png`
- Dark: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-dark-polished.png`
- Narrow: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-mobile-polished.png`


## React Flow and alias-race pass — 2026-09-06

final result: passed

This pass supersedes the canvas implementation described above with bundled
`@xyflow/react` 12.11.6 custom track nodes and branch edges. Native host tokens,
running breath/flow, stopped dashed lines, lineage and existing management actions
remain. React Flow base CSS is embedded in the plugin style lifecycle; no CDN or
separate stylesheet request is required. The browser bundle defines production mode
and avoids Node globals. An initial dependency-cache issue was caught in the test
mirror and fixed before updating the formal host.

- Fixed the creation/polling race: the submitted alias stays neutral while busy;
  pending GETs are aborted and periodic polling pauses during mutations. Real
  duplicates still disable submit; the server remains authoritative.
- Added time-point context menus on tracks/branch edges with coordinate conversion
  through React Flow, clamped to each line's lifetime. Menus display line/time,
  enter the corresponding instance, or open a current-state branch drawer.
- Verified a right-click on ui-preview selected 20:28:42 and populated the drawer
  with ui-preview as source. Created `flow-qa-20260906`, confirmed it ran on 49751
  with ui-preview as parent, entered its DSH shell through the menu, then stopped
  and removed this disposable QA lab. Existing test, ui-preview and asd were retained.
- Observed neutral pending alias feedback and successful completion; duplicate
  `test` was still rejected. Regression tests explicitly simulate a newly listed
  alias appearing before its creation request completes.
- Verified zoom, fit-to-view, Shift+F10, arrow-key focus and Escape returning focus
  to the track without closing the management page. After zooming, right-clicking
  a mid-track point selected the corresponding 19:16 time and aligned the cursor.
- Initial fit clipped ruler captions; adjusted row spacing and asymmetric fit
  padding. Fitting on topology changes brings newly created/filtered lines into view.
- At 390 × 844, verified native collapsed sidebar, readable scrolling cards,
  persistent actions and a menu fully within the graph bounds. Reset viewport after QA.
- Formal DSH at 3080 loads the same verified client and shows the existing three
  persistent world lines plus the formal source, without a server restart.
- Validation: typecheck and client lint pass, browser bundle checked for unresolved
  Node environment references, and 27 test files / 205 tests pass.

Screenshots:
- Formal desktop: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-react-flow-formal.png`
- Narrow menu: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-react-flow-mobile.png`


## Curved branches and entry dive — 2026-09-06

final result: passed for the verified flows

- Replaced vertical T-junction branch paths with cubic curves that leave and join
  their horizontal tracks tangentially. Birth-time endpoints remain unchanged;
  the parent lead-in reserves 40 graph units for a gentle bend. Verified native
  light and dark themes against the actual rendered graph.
- Entry now opens a themed React portal in the new tab immediately. A procedural
  canvas projects depth rings and radial trails; target coordinates settle during
  startup and accelerate only after the API provides the ready destination.
  There are no invented percentage or authentication-success indicators.
- Captured actual linking and warping frames, then verified navigation to the
  intended DSH shell. Tested cancellation before handoff and skip during warp;
  cancellation retained the source graph and skip entered the ready destination.
- Tested light/dark token inheritance in the new document; restored the test host
  to follow-system afterward. Browser error logs were empty. Canvas RAF uses the
  destination window and cleans up on navigation, cancellation and unmount.
- Reduced-motion handling, popup-blocked manual-link fallback and error/return
  states are implemented; those three branches were code-reviewed rather than
  separately forced through browser emulation. Transition tests cover late-ready
  cancellation, cancelling mid-warp, skip waiting for readiness, and single handoff.
- Build, typecheck, client lint and whitespace checks pass; 28 files / 209 tests pass.
  The verified client was copied atomically into the formal DSH profile with a
  backup. No instance ports or runtime states were changed by these entry checks.

Evidence:
- Dark curves: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-curves-dark.png`
- Light warp: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-dive-warp.png`
- Dark warp: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-dive-dark.png`


## Unified time-point actions — 2026-09-06

final result: passed for the verified flows

- Moved default, rename, stop and delete into the same time-point menu as entry
  and branching. Removed the bottom selection/action card and its obsolete styles.
- Menu metadata retains state, port, parent and current-instance information.
  Default/current-instance guards remain visible as disabled actions.
- Rename/delete dialogs bind to the clicked instance ID, independent of selection
  and background refreshes. Verified a no-op alias save against ui-preview; deletion
  required its alias and was cancelled before submission. No lab was deleted.
- Verified complete menu placement at 968 × 862 and 390 × 844. The mobile menu fits
  within the graph, and viewport settings were reset afterward.
- The client was installed atomically with a backup into formal DSH at port 3080.
  Verified all six actions and removal of the bottom card there at 1512 × 806,
  without a server restart. Browser error logs were empty.
- Typecheck, client lint, build and whitespace checks pass.

Evidence:
- Formal menu: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-unified-menu.png`
- Mobile menu: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-unified-menu-mobile.png`


## Checkpoints, event nodes and world comparison — 2026-09-06

Final result: passed for the tested flows.

- Real creation, latest verification and snapshot records appear on the correct
  tracks. Snapshot markers have a distinct shape, a contextual fork action and
  details listing saved plugins/config files. Nearby events aggregate; the
  history panel keeps individual records accessible.
- Saved a named checkpoint on stopped ui-preview through the browser. Created
  checkpoint-qa-20260906 from it; the child recorded parentLabId and snapshotId,
  started at port 58267 and entry reached its independent web-login page. Login
  isolation was preserved; no attempt was made to bypass its login. The temporary
  child was stopped and deleted; the checkpoint remains available on ui-preview.
- Snapshot branches recover profile and home patches from that source's vault.
  Other home data inherits current state. Missing bytes, missing decryption keys
  and changed local plugin code fail closed. Registry versions are checked after
  installation; full-copy fingerprints detect code-only local edits.
- Compared test/ui-preview and main/test in the real host, including Shift multi-
  selection, native select controls and explanatory dependency-change labels.
  Results contain no raw config values or local dependency paths.
- Corrected graph clipping when the detail panel opens by fitting on container
  resize. Verified desktop 1512 × 806 and phone 390 × 844; phone panels scroll
  independently, snapshot fork and comparison controls remain reachable. Viewport
  settings were reset. Browser error logs were empty.
- Installed the client/backend atomically with a full dist backup under
  ~/.dsh/backups/world-line-insights-20260906T232947. Formal DSH stays on 3080;
  test remains on 55333, asd on 64343, and ui-preview remains stopped.
- Build and typecheck pass; 29 world-line test files / 215 tests pass, including
  cross-profile refusal, secret-safe comparison, historical materialization,
  absent-file preservation, local source drift and encrypted profile/home restore.
  Lint has no errors (one function-placement suggestion).

Evidence:
- Checkpoint detail: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-checkpoint-detail.png`
- Phone checkpoint: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-checkpoint-mobile.png`
- Phone comparison: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-compare-mobile.png`

## Immersive canvas and persistent event positions — 2026-09-06

- Replaced the page header/tool row with a floating native-theme icon toolbar. Search, history and comparison expand on demand; inspector overlays no longer resize or refit the graph. Zoom controls are grouped under a canvas-tools icon.
- Historical navigation now stores an absolute timestamp (`null` follows now), so 10-second refreshes cannot drift a historical cursor. All known events remain on the graph; records after the cursor use subdued dashed markers and remain clickable/context-actionable. Dense records retain every event in chronological groups.
- Stable per-ID rail/branch/marker colors use DSH semantic theme tokens and blends. Running/stopped and event/snapshot distinctions also retain shape/style cues.
- Replaced the bottom row with a collapsible time dock: full timestamp, previous/next event, return to now, a scrubber with event ticks and 8-pixel event snapping. Arrow keys move a minute; Shift plus arrow jumps to an event. The inspector leaves room for an expanded dock.
- Narrow screens use the full overlay width, preventing the host sidebar from squeezing controls off-screen. Verified 390 × 844 with no horizontal overflow, including an expanded inspector and scrubber.
- Validation: world-line suite 219 tests passed; typecheck, touched-file Biome and oxlint, and git diff whitespace checks passed. Browser checks covered search/clear, rewind with later snapshot retained, snapshot context menu, fixed historical time across polling, light/dark theme and mobile. Browser error logs were empty.
- Atomically installed the client bundle into formal DSH (3080) and test (55333), with equal SHA-256 hashes. Formal client backup: `/Users/seavey/.dsh/backups/world-line-immersive-20260906T234954/client.js`. No server restart or instance/data mutations required.
- Evidence: `world-line-immersive-formal.png`, `world-line-immersive-mobile.png`, `world-line-immersive-dark.png` under `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/`. Dark screenshot preceded the final amber contrast adjustment; final bundle uses a primary-label blend for theme-dependent luminance.

## Component select — 2026-09-06

- Replaced both native comparison selects with a reusable React `Select` component using DSH theme tokens, a portaled listbox, selected checkmarks, disabled counterparts and ellipsis for long aliases. No native `<select>` remains in the world-line UI.
- Keyboard handling supports arrows, Home/End, typeahead, Enter/Space, Escape and Tab. Trigger focus is retained/restored on selection; outside interaction, scrolling and resize dismiss the popup. Popup placement stays inside the viewport and can open upward.
- Typecheck/build, touched-file Biome/oxlint and whitespace checks passed. Actual browser selection triggered comparison, with the selected value retained and the opposite world line disabled; 390px layout stayed inside the viewport and browser error logs were empty.
- Updated test and formal client bundles atomically without starting or restarting either DSH process.

## Layered system context menus — 2026-09-07

- Introduced a separate React context-menu component with an angular translucent shell, circular action glyphs, a theme-colored side rail and reduced-motion-aware entry/pulse animations. Colors remain derived from the DSH theme.
- Root actions: enter, branches, snapshots/history, compare, management. Branches/history/management open a second level; original action eligibility and deletion confirmation remain intact.
- Menu panels portal into the world-line page above the inspector and selector popups. Whole-canvas context-menu capture now handles snapshot buttons, node text/rails, edge surfaces, handles and blank pane fallback; the browser menu is prevented consistently inside the canvas.
- Floating placement accounts for page/sidebar bounds, flips each level independently, keeps a 4px inter-panel gap, clamps vertically and uses in-panel drill-down when no side has enough room. Compact back navigation restores focus to its parent action.
- Validation: 222 tests passed including left/right/bottom/mobile placement cases; final typecheck/build, changed-file formatting/lint and whitespace checks passed. Browser checks covered left-edge/right-edge expansion, bottom clamping, blank-pane right click, right click on the node action button, management-to-alias dialog (cancelled), compact submenu/back focus, and snapshot menus while the inspector remains open. Formal DOM hit testing confirmed both menus are above the inspector; browser errors were empty.
- Updated formal (3080) and test (55333) client bundles atomically, with byte hashes verified. No DSH startup/restart: existing PIDs remain 29451 and 27948. Backup: `/Users/seavey/.dsh/backups/world-line-system-menu-20260907T000746/client.js`.
- Screenshots: `world-line-system-menu-formal.png` and `world-line-system-menu-mobile.png` in `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/`.

## Convergence and shared navigation — 2026-09-07

- Added selective plugin/profile configuration convergence through an isolated candidate, browser readiness gate, source/target drift checks, runtime hashes, pre-merge snapshot and rollback on file replacement failure. Merge does not restart main automatically. Sessions, credentials and home-wide settings are excluded.
- Child instances resolve the original manager home, including standard-path recovery when environment hints are absent. Inheritance excludes the registry and backups. Tests cover incorrect roots and repeated plugin installation without recursive registries.
- Replaced the sidebar entry with a themed top-right icon, tooltip, return action and persistent child alias. Browser checks on ui-preview and formal DSH confirmed navigation, real merge previews and right-click menus with snapshot details open. No user plugin was merged into main during these checks.
- Corrected native DOM event types in the capture listener that suppresses the browser context menu. Raised the context-menu layer above detail panels.
- Validation: repository static checks and builds pass; world-line has 232 passing tests with coverage thresholds met (74.73% statements, 61.74% branches, 78.97% functions, 77.31% lines). Full repository tests fail in the unrelated pet-desktop Native SDK: its Zig test command fails and external compiler dependencies including scriptc and @typescript/old are missing locally.
- Installed the final dist in formal and ui-preview. Formal DSH was restarted on the same port 3080 (PID 93610); existing browser authentication and the main UI remained usable. Backup: `/Users/seavey/.dsh/backups/world-line-convergence-20260907T150430/`. ui-preview received the client update; its existing backend already exposed the merge preview.

## SAO system-menu reference adaptation — 2026-09-07

final result: passed

- Source: `/var/folders/bz/p58xpnw167vfpzs71y26qbmw0000gn/T/codex-clipboard-70979b96-1037-460f-bb96-d1d2060398ce.png` (800 × 450). Scope is the menu language, not the reference's wallpaper, logos, desktop widgets or English content.
- Implementation screenshots: `/Users/seavey/.codex/visualizations/2026/09/06/01a0753e-68f1-7232-81b5-728371152351/world-line-sao-menu-preview.png` (desktop, 1512 × 862 CSS viewport), and `world-line-sao-menu-mobile.png` in the same directory (390 × 844). Browser screenshot output is at CSS-pixel density. Compared source and implementation together in a single image output, focusing on icon rails, selected bands and expanded submenu rows; pixel-perfect full-page comparison is not applicable to this scoped adaptation.
- Typography/content: preserve DSH Chinese typography and real world-line actions. Reference-specific display lettering and desktop application names are deliberately not copied. Labels remain readable and wrap without losing actions.
- Layout: separated 30px circular icons and rectangular 42px action rows; translucent information panel above the list, gold top/bottom rules, filled pointer glyphs. Submenu first-row alignment follows its parent unless viewport clamping takes priority. Near the right edge it opens left, ending at y=854 inside the 862px viewport.
- Tokens/imagery: gold selection with dark text for contrast; neutral translucent surfaces inherit DSH theme. Existing Phosphor icons supply action and pointer glyphs. There are no raster assets in the requested menu treatment. The source's sky background is outside scope.
- Interaction checks: opened snapshot context menu and its management submenu; alias action opened its dialog and was cancelled; right-edge submenu flipped; 390px menu used inline drill-down, Escape returned to its parent, all actions stayed reachable. No instance mutations were performed. Browser error log was empty and viewport override was reset.
- Comparison history: first rendered comparison found no actionable P0/P1/P2 issues within the requested scope. Expected differences are Chinese text, DSH canvas background, two levels rather than unrelated desktop widgets, and dark selection text for contrast. No follow-up P3 changes required.
- Validation: typecheck/build and touched-file formatting/lint passed; all 234 world-line tests passed. Installed client bundle in ui-preview and formal DSH without restarting either server.
