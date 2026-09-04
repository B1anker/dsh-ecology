#!/usr/bin/env node
// Thin, never-compiled launcher: keeps the shebang and the executable bit on
// the npm `bin` artifact while the compiled logic lives in dist/ (tsc does not
// preserve shebangs reliably across versions, and the launcher must not depend
// on one).
import { main } from '../dist/index.js'

process.exitCode = await main(process.argv.slice(2))
