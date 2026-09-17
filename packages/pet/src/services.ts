/**
 * The host face's service graph: what it takes from the host and the two
 * services it builds on top.
 *
 * The face is one route, so the graph is small — but it is the same shape as
 * every other plugin's here, which is the point: a reader who knows one knows
 * them all, and a test that wants the real route over a fake launcher, or the
 * real launcher over fake seams, swaps a single entry instead of rebuilding
 * the handler by hand. The seams themselves ({@link LaunchDeps}) stay exactly
 * what they were; the launcher service is the object that owns a set of them.
 *
 * @module @seaveyon/dsh-pet/services
 */

import { createDecorator, inject, ServiceCollection, SyncDescriptor } from '@seaveyon/dsh-di'
import { registerHostServices } from '@seaveyon/dsh-di/host'
import type { Disposer, HostContext, RouteHandler, WebServerService } from './host-types.js'
import {
  LAUNCH_ROUTE_PATH,
  type LaunchDeps,
  type LaunchOutcome,
  type LaunchRequest,
  launchDesktopApp,
  launchRouteHandler,
} from './launch.js'

/**
 * The host's route registry, under its Cordis name and this plugin's own
 * contract type (see host-types.ts) rather than the container's minimal one.
 */
export const IWebServer = createDecorator<WebServerService>('webServer')

/** Starts the desktop app. One method, so a test double is one line. */
export interface IDesktopLauncher {
  readonly _serviceBrand: undefined
  launch(request?: LaunchRequest): Promise<LaunchOutcome>
}
export const IDesktopLauncher = createDecorator<IDesktopLauncher>('petDesktopLauncher')

/** {@link launchDesktopApp} over a fixed set of seams. */
export class DesktopLauncher implements IDesktopLauncher {
  declare readonly _serviceBrand: undefined

  constructor(private readonly deps: LaunchDeps = {}) {}

  launch(request: LaunchRequest = {}): Promise<LaunchOutcome> {
    return launchDesktopApp(this.deps, request)
  }
}

/** The launch-desktop route, ready to be registered with the host. */
export interface ILaunchRoute {
  readonly _serviceBrand: undefined
  readonly path: string
  /** Register with the host's `webServer`; the returned disposer unregisters. */
  register(): Disposer
}
export const ILaunchRoute = createDecorator<ILaunchRoute>('petLaunchRoute')

@inject(IWebServer, IDesktopLauncher)
export class LaunchRoute implements ILaunchRoute {
  declare readonly _serviceBrand: undefined
  readonly path = LAUNCH_ROUTE_PATH
  private readonly handler: RouteHandler

  constructor(
    private readonly server: WebServerService,
    launcher: IDesktopLauncher,
  ) {
    this.handler = launchRouteHandler((request) => launcher.launch(request))
  }

  register(): Disposer {
    return this.server.register({ kind: 'exact', path: this.path, handler: this.handler })
  }
}

/**
 * The collection `apply` builds its container from.
 *
 * `webServer` is required — the Loader row injects it, and without it there
 * is nothing to register the route with — and the launcher is built over
 * `deps`, which defaults to the real seams (Launch Services, the filesystem,
 * a detached spawn). A test passes stubs here, or clones the collection and
 * replaces {@link IDesktopLauncher} outright.
 */
export function createServices(ctx: HostContext, deps: LaunchDeps = {}): ServiceCollection {
  const collection = registerHostServices(new ServiceCollection(), ctx, { required: [IWebServer] })
  collection.set(IDesktopLauncher, new SyncDescriptor(DesktopLauncher, [deps]))
  collection.set(ILaunchRoute, new SyncDescriptor(LaunchRoute))
  return collection
}
