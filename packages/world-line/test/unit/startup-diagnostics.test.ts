import { expect, test } from '@rstest/core'
import { startupFailureSummary } from '../../src/lab/launcher.js'

test('nested startup errors retain the missing module rather than trailing braces', () => {
  const result = startupFailureSummary(
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/lab/rescue-bundles.js'\n at load()\n }\n }\n}\nNode.js v24.20.0",
  )
  expect(result).toContain('rescue-bundles.js')
  expect(result).toContain('ERR_MODULE_NOT_FOUND')
  expect(result).not.toContain('Node.js')
})
