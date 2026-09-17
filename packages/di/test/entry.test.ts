/**
 * What the package entry actually hands a consumer.
 *
 * The suites next to this one import from `../src/*.js` directly, which proves
 * nothing about the barrel. A rename that updates every definition and every
 * internal import but not `index.ts` leaves them all green and the published
 * package broken, so the entry is exercised here on its own.
 */

import { expect, test } from '@rstest/core'
import * as di from '../src/index.js'

test('the entry exports the container, the declarations, and the lifecycle helpers', () => {
  expect(Object.keys(di).toSorted()).toEqual([
    'DI_DEPENDENCIES',
    'DI_TARGET',
    'FactoryDescriptor',
    'IInstantiationService',
    'InstantiationService',
    'ServiceCollection',
    'SyncDescriptor',
    'createDecorator',
    'getServiceDependencies',
    'inject',
    'isDisposable',
    'optional',
    'toDisposable',
  ])
  // The DSH-specific identifiers live on their own entry, so the main one stays
  // free of any host vocabulary (and of `node:http` in its declarations).
  expect(Object.keys(di)).not.toContain('IWebServer')
  expect(Object.keys(di)).not.toContain('registerHostServices')
  expect(typeof di.DI_DEPENDENCIES).toBe('symbol')
  expect(typeof di.DI_TARGET).toBe('symbol')
  // The identifier is a function (it doubles as a legacy parameter decorator)
  // and prints as its name.
  expect(typeof di.IInstantiationService).toBe('function')
  expect(String(di.IInstantiationService)).toBe('instantiationService')
})

test('a container built from the entry resolves itself', () => {
  const services = new di.InstantiationService()
  expect(services.get(di.IInstantiationService)).toBe(services)
  services.dispose()
})

test('the host entry exports the DSH identifiers and the bridge', async () => {
  const host = await import('../src/host.js')
  expect(Object.keys(host).toSorted()).toEqual([
    'IConnection',
    'IPluginContext',
    'ITools',
    'IWebServer',
    'registerHostServices',
  ])
})
