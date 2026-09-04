/**
 * The settings panel, mounted into the shell's `settings.section` slot.
 *
 * The plugin renders nothing else on the page — the pet itself lives in the
 * desktop app — so this panel is the plugin's only visible surface: which pet
 * shows on the desktop, its name, and the companion summon button. Every
 * control writes straight into the {@link PetSettingsStore}, which notifies
 * subscribers (the bridge included) so changes take effect with no "save"
 * step, and the store's dual-backend write makes them stick.
 *
 * The picker is single-source: when the desktop app answers `GET /pets`, its
 * roster is the whole list (built-ins included) and every preview is a
 * {@link RasterPet} strip off the bridge server. Until the app answers, the
 * picker shows nothing — the pet lives on the desktop, so a page-side
 * stand-in roster would only promise a choice the desktop cannot honor.
 * The same petId stays selected across reconnects, since ids match on both
 * sides. Previews wear the affection pose (`pet`) when selected, because that
 * is the pose that best distinguishes sprites at thumbnail size.
 *
 * The controls are native elements carrying the host's own recipes —
 * capsule Button, bordered Input, accent-colored checkbox — transcribed over
 * `--dsw-alias-*` tokens so light/dark themes apply with no local palette.
 * Importing the primitives package itself is not viable for an external
 * plugin (one flat browser artifact, no per-component entries; bundling one
 * Button would drag its markdown/highlight stack into this single-file
 * client.js) — see the web-login account panel, which made the same call.
 *
 * @module @seaveyon/dsh-pet/client/settings-panel
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  type DesktopPetsSnapshot,
  type DesktopPetsStore,
  prettifyImportedPetId,
} from './desktop-pets.js'
import { detectLocale, getStrings, type Locale } from './i18n.js'
import {
  DESKTOP_DOWNLOAD_URL,
  isLoopbackHost,
  type LaunchRequestResult,
  requestDesktopLaunch,
} from './launch.js'
import { PETS } from './pets.js'
import { RasterPet } from './raster-pet.js'
import type { PetSettingsStore } from './settings.js'

export interface PetSettingsPanelProps {
  settings: PetSettingsStore
  /**
   * Desktop-pet discovery. Absent in tests and minimal mounts: the picker
   * stays empty and no fetch is attempted.
   */
  desktopPets?: DesktopPetsStore
  /**
   * Delay between discovery retries after a failed fetch, while the panel
   * stays open. Defaults to {@link RETRY_DELAY_MS}; injectable for tests.
   */
  retryDelayMs?: number
  /**
   * How often the open panel re-checks the connection, so quitting the
   * desktop app flips the panel back to the summon state. Defaults to
   * {@link POLL_INTERVAL_MS}; injectable for tests.
   */
  pollIntervalMs?: number
  /**
   * Asks the host to launch the desktop app. Defaults to
   * {@link requestDesktopLaunch}; injectable for tests.
   */
  requestLaunch?: () => Promise<LaunchRequestResult>
  /**
   * Post-launch discovery nudges: the app needs a moment to boot and bind the
   * bridge port. Injectable for tests.
   */
  launchRefreshDelaysMs?: readonly number[]
}

const FALLBACK_SNAPSHOT: DesktopPetsSnapshot = { pets: [], status: 'unknown' }
const NOOP_SUBSCRIBE = () => () => {}

/**
 * The host's control recipes over `--dsw-alias-*` tokens (see the module
 * header): the compact capsule Button and the bordered Input.
 */
const PANEL_CSS = `
.dsh-pet-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 14px;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  font-weight: 560;
  cursor: pointer;
}
.dsh-pet-control.primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}
.dsh-pet-control.primary:hover {
  background: var(--dsw-alias-button-primary-hover);
}
.dsh-pet-control:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-pet-control.primary:disabled:hover {
  background: var(--dsw-alias-button-primary-fill);
}
.dsh-pet-input {
  box-sizing: border-box;
  width: min(260px, 100%);
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  outline: none;
}
.dsh-pet-input:focus {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-pet-link {
  color: var(--dsw-alias-brand-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
`

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
} as const

const rowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(7rem, 9rem) 1fr',
  gap: '8px 12px',
  alignItems: 'center',
  margin: 0,
  fontSize: '13px',
  lineHeight: 1.45,
} as const

const labelStyle = {
  color: 'var(--dsw-alias-label-secondary)',
} as const

const hintStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: '12px',
  lineHeight: 1.45,
} as const

const actionsStyle = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '8px',
} as const

/** The picker's tile is 56px with a 2px border; the preview gets the rest. */
const PREVIEW_SIZE = 52

/** After a failed fetch, retry twice while the panel is open — then stop. */
const RETRY_COUNT = 2
const RETRY_DELAY_MS = 2000

/**
 * How often an open panel re-checks the connection: the desktop app can be
 * quit at any moment, and a stale snapshot would keep claiming "connected"
 * for a pet that is gone. Cheap — one small fetch per tick.
 */
const POLL_INTERVAL_MS = 5000

/**
 * After a successful launch request, nudge discovery at these delays: the
 * desktop app needs a moment to boot and bind the bridge port. If the last
 * nudge still finds it offline, the launch is reported as failed.
 */
const LAUNCH_REFRESH_DELAYS_MS: readonly number[] = [400, 1200, 2500]

/** The panel-side lifecycle of one launch attempt. */
type LaunchState = 'idle' | 'busy' | 'not-installed' | 'failed'

/**
 * The picker's display name for a pet id: the three built-ins keep their
 * localized names; anything else is an import, humanized from its id.
 */
function displayName(petId: string, locale: Locale): string {
  const known = PETS.find((pet) => pet.id === petId)
  return known === undefined ? prettifyImportedPetId(petId) : known.label[locale]
}

/** The tile chrome every picker button shares, selected or not. */
function tileStyle(selected: boolean) {
  return {
    position: 'relative',
    width: '56px',
    height: '56px',
    padding: 0,
    borderRadius: '10px',
    cursor: 'pointer',
    border: selected
      ? '2px solid var(--dsw-alias-brand-primary, #4b6bfb)'
      : '2px solid transparent',
    background: 'var(--dsw-alias-bg-layer-1, #f3f4f6)',
    overflow: 'hidden',
  } as const
}

export function PetSettingsPanel({
  settings,
  desktopPets,
  retryDelayMs = RETRY_DELAY_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  requestLaunch = requestDesktopLaunch,
  launchRefreshDelaysMs = LAUNCH_REFRESH_DELAYS_MS,
}: PetSettingsPanelProps) {
  const strings = getStrings()
  const locale = detectLocale(navigator.language)
  const config = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const subscribeDiscovery = useCallback(
    (listener: () => void) => desktopPets?.subscribe(listener) ?? NOOP_SUBSCRIBE(),
    [desktopPets],
  )
  const getDiscoverySnapshot = useCallback(
    () => desktopPets?.getSnapshot() ?? FALLBACK_SNAPSHOT,
    [desktopPets],
  )
  const discovery = useSyncExternalStore(subscribeDiscovery, getDiscoverySnapshot)

  // Opening the panel is the discovery moment: the desktop app is the kind of
  // thing users start right before importing a pet, so a failed fetch gets a
  // couple of quiet retries while the panel stays open — then it stops.
  useEffect(() => {
    if (desktopPets === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = async (remainingRetries: number) => {
      await desktopPets.refresh()
      if (cancelled) return
      if (desktopPets.getSnapshot().status === 'offline' && remainingRetries > 0) {
        timer = setTimeout(() => void attempt(remainingRetries - 1), retryDelayMs)
      }
    }
    void attempt(RETRY_COUNT)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [desktopPets, retryDelayMs])

  // Keep the status honest while the panel is open: the desktop app can be
  // quit at any moment, and only a fresh fetch tells "connected" apart from
  // a ghost — the store alone holds the last answer forever.
  useEffect(() => {
    if (desktopPets === undefined) return
    const timer = setInterval(() => void desktopPets.refresh(), pollIntervalMs)
    return () => clearInterval(timer)
  }, [desktopPets, pollIntervalMs])

  const online = discovery.status === 'online'

  // Launching a local process is possible only through the host face, and
  // only makes sense when server and browser share the machine — see
  // client/launch.ts. `canLaunch` is display logic; the server re-checks.
  const canLaunch = desktopPets !== undefined && isLoopbackHost(window.location.hostname)
  const [launchState, setLaunchState] = useState<LaunchState>('idle')
  const launchTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(
    () => () => {
      for (const timer of launchTimers.current) clearTimeout(timer)
    },
    [],
  )

  const onLaunch = useCallback(async () => {
    if (desktopPets === undefined) return
    setLaunchState('busy')
    const result = await requestLaunch()
    if (result !== 'launched') {
      setLaunchState(result === 'not-installed' ? 'not-installed' : 'failed')
      return
    }
    launchRefreshDelaysMs.forEach((delay, index) => {
      launchTimers.current.push(
        setTimeout(() => {
          void desktopPets.refresh().then(() => {
            const last = index === launchRefreshDelaysMs.length - 1
            if (last && desktopPets.getSnapshot().status !== 'online') setLaunchState('failed')
          })
        }, delay),
      )
    })
  }, [desktopPets, requestLaunch, launchRefreshDelaysMs])

  // A successful launch ends when the desktop actually answers: the leftover
  // nudges are done, and `busy` clears back to `idle`. Without this the state
  // would stay `busy` forever (the connected readout hides the button, so
  // nothing else resets it), and quitting the app later would resurrect a
  // stuck, disabled "starting" button instead of a clickable launch button.
  useEffect(() => {
    if (discovery.status !== 'online' || launchState !== 'busy') return
    for (const timer of launchTimers.current) clearTimeout(timer)
    launchTimers.current = []
    setLaunchState('idle')
  }, [discovery.status, launchState])

  // The summon button is the companion's one control: it turns the bridge
  // on (if it ever was off) and asks the host to launch the desktop app.
  const onSummon = useCallback(() => {
    if (!config.companionEnabled) settings.update({ companionEnabled: true })
    void onLaunch()
  }, [config.companionEnabled, settings, onLaunch])

  // The companion row's two faces: a connected readout once the desktop
  // app answers, the summon button otherwise (an offline desktop, or a
  // companion that was switched off, both want it). Unknown status shows
  // neither — the first fetch has not settled yet.
  const connected = online && config.companionEnabled
  const showSummon = canLaunch && (discovery.status === 'offline' || !config.companionEnabled)

  return (
    <section aria-label={strings.settingsSection} style={sectionStyle}>
      {/* The host control recipes; the raster previews carry their own CSS. */}
      <style>{PANEL_CSS}</style>
      <p style={hintStyle}>{strings.desktopHint}</p>
      {discovery.status === 'offline' && <p style={hintStyle}>{strings.desktopOfflineHint}</p>}
      {online && (
        <div style={rowStyle}>
          <span style={labelStyle}>{strings.appearanceLabel}</span>
          <div
            role="group"
            aria-label={strings.appearanceLabel}
            style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}
          >
            {discovery.pets.map((pet) => {
              const selected = config.petId === pet.id
              const imported = !PETS.some((builtin) => builtin.id === pet.id)
              return (
                <button
                  key={pet.id}
                  type="button"
                  title={displayName(pet.id, locale)}
                  aria-pressed={selected}
                  onClick={() => settings.update({ petId: pet.id })}
                  style={tileStyle(selected)}
                >
                  <RasterPet pet={pet} mood={selected ? 'pet' : 'idle'} size={PREVIEW_SIZE} />
                  {imported && (
                    <span
                      style={{
                        position: 'absolute',
                        right: '2px',
                        bottom: '2px',
                        padding: '0 4px',
                        borderRadius: '6px',
                        fontSize: '9px',
                        lineHeight: '14px',
                        background: 'var(--dsw-alias-button-primary-fill, #4b6bfb)',
                        color: 'var(--dsw-alias-label-primary-foreground, #fff)',
                        pointerEvents: 'none',
                      }}
                    >
                      {strings.desktopPetBadge}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <label style={rowStyle}>
        <span style={labelStyle}>{strings.nameLabel}</span>
        <span>
          <input
            type="text"
            className="dsh-pet-input"
            value={config.name}
            onChange={(event) => settings.update({ name: event.target.value })}
          />
        </span>
      </label>
      <div style={rowStyle}>
        <span style={labelStyle}>{strings.companionLabel}</span>
        <span style={actionsStyle}>
          {connected && <span style={hintStyle}>{strings.companionConnected}</span>}
          {showSummon && (
            <>
              <button
                type="button"
                className="dsh-pet-control primary"
                disabled={launchState === 'busy'}
                onClick={onSummon}
              >
                {launchState === 'busy' ? strings.launchStarting : strings.launchButton}
              </button>
              {launchState === 'not-installed' && (
                <span style={hintStyle}>
                  {strings.launchNotInstalled}{' '}
                  <a
                    href={DESKTOP_DOWNLOAD_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="dsh-pet-link"
                  >
                    {strings.launchDownloadLabel}
                  </a>
                </span>
              )}
              {launchState === 'failed' && <span style={hintStyle}>{strings.launchFailed}</span>}
            </>
          )}
        </span>
      </div>
    </section>
  )
}
