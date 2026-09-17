/**
 * The host plugin's service graph: the two host services it takes, where
 * this instance lives, and the services it builds on top.
 *
 * `apply` (./index) builds an `InstantiationService` over this collection
 * and resolves the management API and the context factory from it; the
 * effects it mounts (invalidation watcher, upgrade scheduler, result-window
 * ownership) stay in `apply`, because they are lifecycle, not services. A
 * test that wants the real API over a fake connection, or a fake context
 * factory under the real API, builds this collection and replaces one entry.
 *
 * @module @seaveyon/dsh-world-line/web/services
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inject, ServiceCollection, SyncDescriptor } from '@seaveyon/dsh-di'
import { registerHostServices } from '@seaveyon/dsh-di/host'
import type { CliContext } from '../context.js'
import { loadDshEnvironment, loadExperimentEnvironment } from '../environment.js'
import { currentLabId, managerHome } from '../lab/manager.js'
import { ManagementApi } from './api.js'
import {
  IConnection,
  IContextFactory,
  ILocation,
  IManagementApi,
  IOperateDeps,
  IReadCache,
  IWebServer,
  type WebContext,
  type WorldLineLocation,
} from './identifiers.js'
import { readCache } from './operations.js'

/** The default context factory: {@link WorldLineLocation} plus the process environment. */
@inject(ILocation)
export class ContextFactory implements IContextFactory {
  declare readonly _serviceBrand: undefined

  constructor(
    private readonly location: WorldLineLocation,
    private readonly processEnv: NodeJS.ProcessEnv,
  ) {}

  async create(): Promise<CliContext> {
    const { home, profileName } = this.location
    const env = await loadDshEnvironment(home, this.processEnv)
    return {
      home,
      env,
      experimentEnv: await loadExperimentEnvironment(env, this.processEnv),
      cwd: home,
      profileName,
      json: true,
      breakStaleLock: false,
      now: () => new Date(),
    }
  }
}

/** Where this instance lives, read from the environment. */
export function locate(
  env: NodeJS.ProcessEnv,
  profileName: string,
  fallbackHome = join(homedir(), '.dsh'),
): WorldLineLocation {
  const runtimeHome = resolve(env.DSH_HOME ?? fallbackHome)
  const currentId = currentLabId(runtimeHome, env.WORLD_LINE_LAB)
  const home = managerHome(runtimeHome, currentId, env.WORLD_LINE_MANAGER_HOME)
  return { runtimeHome, currentId, home, profileName }
}

/**
 * The collection `apply` builds its container from.
 *
 * Both host services are required: the API is authenticated by
 * `connection.requestRejection` on every request, so a host without it is
 * refused at `apply` rather than served open. `env` defaults to the process
 * environment; a test passes its own to point the location at a fixture.
 */
export function createServices(
  host: WebContext,
  config: { profile?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): ServiceCollection {
  const connection = host.get<Partial<ConnectionServiceLike>>('connection')
  if (host.get('webServer') === undefined || typeof connection?.requestRejection !== 'function') {
    throw new Error('World Line requires DSH browser authentication')
  }
  const collection = registerHostServices(new ServiceCollection(), host, {
    required: [IWebServer, IConnection],
  })
  collection.set(ILocation, locate(env, config.profile ?? 'web'))
  collection.set(IReadCache, readCache)
  collection.set(IOperateDeps, {})
  collection.set(IContextFactory, new SyncDescriptor(ContextFactory, [env]))
  collection.set(IManagementApi, new SyncDescriptor(ManagementApi))
  return collection
}

type ConnectionServiceLike = { requestRejection: unknown }
