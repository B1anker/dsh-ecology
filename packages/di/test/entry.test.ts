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
