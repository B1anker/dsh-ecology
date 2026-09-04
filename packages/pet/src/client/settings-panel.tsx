/**
 * The settings panel, mounted into the shell's `settings.section` slot.
 *
 * The plugin renders nothing else on the page — the pet itself lives in the
 * desktop app — so this panel is the plugin's only visible surface: which pet
 * shows on the desktop, its name, and the companion bridge switch. Every
 * control writes straight into the {@link PetSettingsStore}, which notifies
 * subscribers (the bridge included) so changes take effect with no "save"
 * step, and the store's dual-backend write makes them stick.
 *
 * The picker is single-source: when the desktop app answers `GET /pets`, its
 * roster is the whole list (built-ins included) and every preview is a
 * {@link RasterPet} strip off the bridge server. Only a proven-unreachable
 * desktop falls back to the built-in SVG roster with a "not connected" hint.
 * The same petId stays selected across the switch, since ids match on both
 * sides. Previews wear the affection pose (`pet`) when selected, because that
 * is the pose that best distinguishes sprites at thumbnail size.
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
import { PET_STYLE_CSS, PETS } from './pets.js'
import { RasterPet } from './raster-pet.js'
import type { PetSettingsStore } from './settings.js'

export interface PetSettingsPanelProps {
  settings: PetSettingsStore
  /**
   * Desktop-pet discovery. Absent in tests and minimal mounts: the picker
   * falls back to the built-in roster and no fetch is attempted.
   */
  desktopPets?: DesktopPetsStore
  /**
   * Delay between discovery retries after a failed fetch, while the panel
   * stays open. Defaults to {@link RETRY_DELAY_MS}; injectable for tests.
   */
  retryDelayMs?: number
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

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBlock: '8px',
} as const

const FALLBACK_SNAPSHOT: DesktopPetsSnapshot = { pets: [], status: 'unknown' }
const NOOP_SUBSCRIBE = () => () => {}

/** The picker's tile is 56px with a 2px border; the preview gets the rest. */
const PREVIEW_SIZE = 52

/** After a failed fetch, retry twice while the panel is open — then stop. */
const RETRY_COUNT = 2
const RETRY_DELAY_MS = 2000

/**
 * After a successful launch request, nudge discovery at these delays: the
 * desktop app needs a moment to boot and bind the bridge port. If the last
 * nudge still finds it offline, the launch is reported as failed.
 */
const LAUNCH_REFRESH_DELAYS_MS: readonly number[] = [400, 1200, 2500]

/** The panel-side lifecycle of one launch attempt. */
type LaunchState = 'idle' | 'busy' | 'not-installed' | 'failed'

/**
 * The picker's display name for a pet id: the four built-ins keep their
 * localized names (deepseek-chan is「DeepSeek 酱」, not "Deepseek Chan");
 * anything else is an import, humanized from its id.
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
    border: selected ? '2px solid var(--dsw-color-primary, #4b6bfb)' : '2px solid transparent',
    background: 'var(--dsw-color-surface, #f3f4f6)',
    overflow: 'hidden',
  } as const
}

export function PetSettingsPanel({
  settings,
  desktopPets,
  retryDelayMs = RETRY_DELAY_MS,
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

  // Turning the companion ON against a proven-offline desktop is the user's
  // "make it work" gesture: fire one launch attempt alongside the setting.
  const onCompanionChange = useCallback(
    (enabled: boolean) => {
      settings.update({ companionEnabled: enabled })
      if (enabled && canLaunch && desktopPets?.getSnapshot().status === 'offline') {
        void onLaunch()
      }
    },
    [settings, canLaunch, desktopPets, onLaunch],
  )

  return (
    <section aria-label={strings.settingsSection}>
      {/* The built-in previews' keyframes; the raster previews carry their own. */}
      <style>{PET_STYLE_CSS}</style>
      <p style={{ marginBlock: '8px', opacity: 0.75 }}>{strings.desktopHint}</p>
      {discovery.status === 'offline' && (
        <p style={{ marginBlock: '8px', opacity: 0.75 }}>{strings.desktopOfflineHint}</p>
      )}
      {discovery.status === 'offline' && config.companionEnabled && canLaunch && (
        <div style={rowStyle}>
          <button type="button" disabled={launchState === 'busy'} onClick={() => void onLaunch()}>
            {launchState === 'busy' ? strings.launchStarting : strings.launchButton}
          </button>
          {launchState === 'not-installed' && (
            <span style={{ opacity: 0.75 }}>
              {strings.launchNotInstalled}{' '}
              <a href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                {strings.launchDownloadLabel}
              </a>
            </span>
          )}
          {launchState === 'failed' && (
            <span style={{ opacity: 0.75 }}>{strings.launchFailed}</span>
          )}
        </div>
      )}
      <div
        role="group"
        aria-label={strings.appearanceLabel}
        style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}
      >
        {online
          ? discovery.pets.map((pet) => {
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
                        background: 'var(--dsw-color-primary, #4b6bfb)',
                        color: 'var(--dsw-color-surface, #fff)',
                        pointerEvents: 'none',
                      }}
                    >
                      {strings.desktopPetBadge}
                    </span>
                  )}
                </button>
              )
            })
          : PETS.map((pet) => (
              <button
                key={pet.id}
                type="button"
                title={pet.label[locale]}
                aria-pressed={config.petId === pet.id}
                onClick={() => settings.update({ petId: pet.id })}
                style={tileStyle(config.petId === pet.id)}
                // Sprite markup is generated by pets.ts, never from user data.
                // biome-ignore lint/security/noDangerouslySetInnerHtml: see pets.ts
                dangerouslySetInnerHTML={{
                  __html: pet.svg(config.petId === pet.id ? 'pet' : 'idle'),
                }}
              />
            ))}
      </div>
      <label style={rowStyle}>
        {strings.nameLabel}
        <input
          type="text"
          value={config.name}
          onChange={(event) => settings.update({ name: event.target.value })}
        />
      </label>
      <label style={rowStyle}>
        {strings.companionLabel}
        <input
          type="checkbox"
          checked={config.companionEnabled}
          onChange={(event) => onCompanionChange(event.target.checked)}
        />
      </label>
    </section>
  )
}
