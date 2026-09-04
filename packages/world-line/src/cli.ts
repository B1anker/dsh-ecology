/**
 * `dsh-world-line` CLI (WORLD-LINE-SPEC §3): argument parsing, dispatch,
 * exit-code mapping, and the machine-readable envelope.
 *
 * Exit codes: 0 success · 1 verification failed · 2 usage/file error ·
 * 3 internal invariant error. `--json` wraps every outcome in a
 * `{ schemaVersion, command, ok, data|error }` envelope on stdout; without
 * it, results go to stdout and errors to stderr.
 */

import type { DoctorResult } from './commands/doctor.js'
import { runDoctor } from './commands/doctor.js'
import type {
  LabActionResult,
  LabDestroyResult,
  LabInspectResult,
  LabListResult,
  LabPromoteCommandResult,
  LabVerbOptions,
} from './commands/lab.js'
import {
  renderLabVerb,
  runLabAdd,
  runLabConfigApply,
  runLabDestroy,
  runLabInspect,
  runLabList,
  runLabPromoteCommand,
  runLabRemove,
  runLabUpdate,
} from './commands/lab.js'
import type { SnapshotCreateResult } from './commands/snapshot.js'
import { runSnapshotCreate } from './commands/snapshot.js'
import type {
  TimelineDiffResult,
  TimelineListResult,
  TimelineShowResult,
} from './commands/timeline.js'
import {
  latestSnapshotId,
  runTimelineDiff,
  runTimelineList,
  runTimelineShow,
} from './commands/timeline.js'
import type { CliContext } from './context.js'
import { UsageError, WlError } from './domain/errors.js'
import { redactText } from './domain/redaction.js'
import { resolveDshHome } from './fs/paths.js'
import { DEFAULT_PROFILE, ENVELOPE_SCHEMA_VERSION, WORLD_LINE_VERSION } from './identity.js'

/** Commands delivered in later phases, rejected with a roadmap message. */
const PHASE_GATED: Record<string, string> = {
  restore: 'restore lands in Phase 4',
  rescue: 'rescue lands in Phase 4',
  report: 'diagnostic reports land in Phase 4',
}

const HELP = `dsh-world-line ${WORLD_LINE_VERSION} — safe change manager for DSH profiles

usage:
  dsh-world-line [--dsh-home <path>] [--profile <name>] <command> [options]

global options:
  --dsh-home <path>   DSH home (default: $DSH_HOME, else ~/.dsh)
  --profile <name>    profile to manage (default: ${DEFAULT_PROFILE})
  --json              machine-readable envelope on stdout
  -h, --help          show this help
  -V, --version       print the package version and exit

commands (Phase 0-3 milestone):
  doctor                          read-only diagnostics (exit 1 when a check fails)
  snapshot create [--label <t>]   capture the profile into the time machine
                                  [--break-stale-lock] confirm a stale writer lock
  timeline list                   list snapshots of the current profile
  timeline show <snapshot-id>     show one snapshot's manifest
  timeline diff <a> <b>           semantic diff between two snapshots
  lab add <spec> [--keep]         verify a candidate plugin in an isolated lab
                                  [--allow-scripts] run package build scripts
  lab add <spec> --promote        verify with browser probes, then promote (§7)
  lab update <pkg> [--keep] [--allow-scripts] [--promote]
  lab remove <pkg> [--keep] [--allow-scripts] [--promote]
  lab config apply <patch.yml> [--keep] [--promote]
                                  --accept-inconclusive accept a skipped client probe
                                  --restart boot the official profile and re-verify
  lab promote <lab-id> [--accept-inconclusive] [--restart]
                                  promote a retained passed lab (auto snapshots,
                                  atomic same-fs swap, journal; rollback on restart fail)
  lab list                        retained labs (expired failures reaped)
  lab inspect <lab-id>            one lab's manifest and probe records
  lab destroy <lab-id>            remove one lab

later phases: restore · rescue · report (see WORLD-LINE-SPEC §11)

exit codes: 0 ok · 1 verification failed · 2 usage/file error · 3 internal error
`

/** A fully parsed invocation. */
interface Invocation {
  context: CliContext
  command: string
  args: string[]
}

/** Parse argv into an invocation (throws {@link UsageError}). */
export function parseInvocation(
  argv: readonly string[],
  io: { cwd: string; env: NodeJS.ProcessEnv; now?: () => Date },
): Invocation {
  const env = io.env
  let homeExplicit: string | undefined
  let profileName = DEFAULT_PROFILE
  let json = false
  let breakStaleLock = false
  const positionals: string[] = []

  // Peek the next token as a flag value. Space-separated values may appear
  // interleaved with positionals, so consume from the cursor, not the tail.
  const valueAfter = (flag: string, index: number): { value: string; next: number } => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('-')) {
      throw new UsageError(`${flag} needs a value`)
    }
    return { value, next: index + 1 }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (token === '--json') {
      json = true
      continue
    }
    if (token === '--break-stale-lock') {
      breakStaleLock = true
      continue
    }
    const homeMatch = /^--dsh-home=(.*)$/.exec(token)
    if (token === '--dsh-home' || homeMatch !== null) {
      const taken =
        homeMatch !== null
          ? { value: homeMatch[1] ?? '', next: index }
          : valueAfter('--dsh-home', index)
      homeExplicit = taken.value
      index = taken.next
      continue
    }
    const profileMatch = /^--profile=(.*)$/.exec(token)
    if (token === '--profile' || profileMatch !== null) {
      const taken =
        profileMatch !== null
          ? { value: profileMatch[1] ?? '', next: index }
          : valueAfter('--profile', index)
      profileName = taken.value
      index = taken.next
      continue
    }
    // Unknown options belong to the command layer (e.g. `--label`): pass them
    // through; dispatch validates them against each command's option table.
    positionals.push(token)
  }

  const [command = '', ...args] = positionals
  const home = resolveDshHome(homeExplicit, env)
  return {
    context: {
      cwd: io.cwd,
      env,
      home,
      profileName,
      json,
      breakStaleLock,
      now: io.now ?? (() => new Date()),
    },
    command,
    args,
  }
}

interface CommandResult {
  command: string
  data: unknown
}

/** Run one parsed command; returns its result or throws. */
async function dispatch(ctx: CliContext, command: string, args: string[]): Promise<CommandResult> {
  switch (command) {
    case 'doctor': {
      expectNoArgs(command, args)
      return { command, data: await runDoctor(ctx) }
    }
    case 'snapshot': {
      const sub = args[0]
      if (sub === undefined) throw new UsageError('snapshot needs a subcommand (create)')
      if (sub === 'create') {
        const { rest, options } = consumeOptions(args.slice(1), { label: 'string' })
        expectNoArgs(`${command} ${sub}`, rest)
        const result = await runSnapshotCreate(ctx, {
          label: typeof options.label === 'string' ? options.label : null,
        })
        return { command: 'snapshot create', data: result }
      }
      throw new UsageError(`unknown snapshot subcommand ${JSON.stringify(sub)} (available: create)`)
    }
    case 'timeline': {
      const sub = args[0]
      if (sub === undefined) throw new UsageError('timeline needs a subcommand (list|show|diff)')
      if (sub === 'list') {
        expectNoArgs('timeline list', args.slice(1))
        return { command: 'timeline list', data: await runTimelineList(ctx) }
      }
      if (sub === 'show') {
        const [id] = args.slice(1)
        if (args.length > 2) throw new UsageError('timeline show takes one snapshot id')
        const resolvedId = id === undefined ? await latestSnapshotId(ctx) : id
        return { command: 'timeline show', data: await runTimelineShow(ctx, resolvedId) }
      }
      if (sub === 'diff') {
        const [aId, bId] = args.slice(1)
        if (aId === undefined || bId === undefined) {
          throw new UsageError('timeline diff needs two snapshot ids (<a> <b>)')
        }
        if (args.length > 3) throw new UsageError('timeline diff takes exactly two snapshot ids')
        return { command: 'timeline diff', data: await runTimelineDiff(ctx, aId, bId) }
      }
      throw new UsageError(
        `unknown timeline subcommand ${JSON.stringify(sub)} (available: list, show, diff)`,
      )
    }
    case 'lab': {
      const sub = args[0]
      if (sub === undefined) {
        throw new UsageError(
          'lab needs a subcommand (add|update|remove|config|list|inspect|destroy)',
        )
      }
      if (sub === 'list') {
        expectNoArgs('lab list', args.slice(1))
        return { command: 'lab list', data: await runLabList(ctx) }
      }
      if (sub === 'inspect') {
        const [labId] = args.slice(1)
        if (args.length > 2) throw new UsageError('lab inspect takes one lab id')
        if (labId === undefined) throw new UsageError('lab inspect needs a lab id')
        return { command: 'lab inspect', data: await runLabInspect(ctx, labId) }
      }
      if (sub === 'destroy') {
        const [labId] = args.slice(1)
        if (args.length > 2) throw new UsageError('lab destroy takes one lab id')
        if (labId === undefined) throw new UsageError('lab destroy needs a lab id')
        return { command: 'lab destroy', data: await runLabDestroy(ctx, labId) }
      }
      if (sub === 'promote') {
        const [labId, ...rest] = args.slice(1)
        if (labId === undefined) throw new UsageError('lab promote needs a lab id')
        const { rest: optionsRest, options } = consumeOptions(rest, {
          'accept-inconclusive': 'boolean',
          restart: 'boolean',
        })
        expectNoArgs('lab promote', optionsRest)
        return {
          command: 'lab promote',
          data: await runLabPromoteCommand(ctx, labId, {
            ...(options['accept-inconclusive'] === true ? { acceptInconclusive: true } : {}),
            ...(options.restart === true ? { restart: true } : {}),
          }),
        }
      }
      if (sub === 'config') {
        const [apply, patchFile, ...rest] = args.slice(1)
        if (apply !== 'apply') {
          throw new UsageError('lab config only supports apply (lab config apply <patch.yml>)')
        }
        if (patchFile === undefined) throw new UsageError('lab config apply needs a patch file')
        const { rest: optionsRest, options } = consumeOptions(rest, {
          keep: 'boolean',
          'allow-scripts': 'boolean',
          promote: 'boolean',
          'accept-inconclusive': 'boolean',
          restart: 'boolean',
        })
        expectNoArgs('lab config apply', optionsRest)
        return {
          command: 'lab config apply',
          data: await runLabConfigApply(ctx, patchFile, {
            ...(options.keep === true ? { keep: true } : {}),
            ...(options['allow-scripts'] === true ? { allowScripts: true } : {}),
            ...(options.promote === true ? { promote: true } : {}),
            ...(options['accept-inconclusive'] === true ? { acceptInconclusive: true } : {}),
            ...(options.restart === true ? { restart: true } : {}),
          }),
        }
      }
      const { rest, options } = consumeOptions(args.slice(1), {
        keep: 'boolean',
        'allow-scripts': 'boolean',
        promote: 'boolean',
        'accept-inconclusive': 'boolean',
        restart: 'boolean',
      })
      const verbOptions: LabVerbOptions = {
        ...(options.keep === true ? { keep: true } : {}),
        ...(options['allow-scripts'] === true ? { allowScripts: true } : {}),
        ...(options.promote === true ? { promote: true } : {}),
        ...(options['accept-inconclusive'] === true ? { acceptInconclusive: true } : {}),
        ...(options.restart === true ? { restart: true } : {}),
      }
      const [spec, ...extra] = rest
      expectNoArgs(`lab ${sub}`, extra)
      if (spec === undefined) {
        throw new UsageError(
          `lab ${sub} needs ${sub === 'remove' ? 'a package name' : 'a candidate spec'}`,
        )
      }
      if (sub === 'add') {
        return { command: 'lab add', data: await runLabAdd(ctx, spec, verbOptions) }
      }
      if (sub === 'update') {
        return { command: 'lab update', data: await runLabUpdate(ctx, spec, verbOptions) }
      }
      if (sub === 'remove') {
        return { command: 'lab remove', data: await runLabRemove(ctx, spec, verbOptions) }
      }
      throw new UsageError(
        `unknown lab subcommand ${JSON.stringify(sub)} (available: add, update, remove, config, list, inspect, destroy)`,
      )
    }
    default: {
      const gate = PHASE_GATED[command]
      if (gate !== undefined) {
        throw new UsageError(`${command} is not implemented yet — ${gate}`)
      }
      throw new UsageError(`unknown command ${JSON.stringify(command)} — run dsh-world-line --help`)
    }
  }
}

/** Consume `--flag value` / `--flag=value` options from a positional list. */
function consumeOptions(
  args: string[],
  kinds: Record<string, 'string' | 'boolean'>,
): { rest: string[]; options: Record<string, string | boolean | undefined> } {
  const options: Record<string, string | boolean | undefined> = {}
  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? ''
    const match = /^--([A-Za-z0-9-]+)(?:=(.*))?$/.exec(token)
    if (match === null) {
      rest.push(token)
      continue
    }
    const flag = match[1] ?? ''
    const kind = kinds[flag]
    if (kind === undefined) throw new UsageError(`unknown option --${flag}`)
    if (kind === 'boolean') {
      options[flag] = true
      continue
    }
    const inline = match[2]
    if (inline !== undefined) {
      options[flag] = inline
      continue
    }
    const value = args[index + 1]
    if (value === undefined) throw new UsageError(`--${flag} needs a value`)
    options[flag] = value
    index += 1
  }
  return { rest, options }
}

/** Reject leftover positional arguments. */
function expectNoArgs(command: string, args: string[]): void {
  if (args.length > 0) {
    throw new UsageError(`${command} takes no positional arguments, got ${args.join(' ')}`)
  }
}

/** Render a successful result for the terminal. */
function renderHuman(command: string, data: unknown): string {
  switch (command) {
    case 'doctor':
      return renderDoctor(data as DoctorResult)
    case 'snapshot create':
      return renderSnapshotCreate(data as SnapshotCreateResult)
    case 'timeline list':
      return renderTimelineList(data as TimelineListResult)
    case 'timeline show':
      return renderTimelineShow(data as TimelineShowResult)
    case 'timeline diff':
      return renderTimelineDiff(data as TimelineDiffResult)
    case 'lab add':
    case 'lab update':
    case 'lab remove':
    case 'lab config apply':
      return renderLabVerb(data as LabActionResult)
    case 'lab list':
      return renderLabList(data as LabListResult)
    case 'lab inspect':
      return renderLabInspect(data as LabInspectResult)
    case 'lab destroy':
      return renderLabDestroy(data as LabDestroyResult)
    case 'lab promote':
      return renderLabPromote(data as LabPromoteCommandResult)
    default:
      return ''
  }
}

function renderLabList(result: LabListResult): string {
  if (result.labs.length === 0) {
    const line =
      `no labs for profile ${result.profileName} yet — ` +
      `run \`dsh-world-line lab add <spec>\` to verify a candidate`
    return result.reaped.length > 0
      ? `${line}
reaped    ${result.reaped.length} expired lab(s)
`
      : `${line}
`
  }
  const rows = result.labs.map((lab) => [
    lab.id,
    lab.profileName,
    lab.state,
    `${lab.runCount} runs`,
    lab.lastOk === null ? '-' : lab.lastOk ? 'ok' : 'failed',
    lab.port !== undefined ? String(lab.port) : '-',
  ])
  const widths = [0, 1, 2, 3, 4, 5].map((column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length), 'profile'.length),
  )
  const render = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  const lines = [
    render(['id', 'profile', 'state', 'runs', 'verdict', 'port']),
    ...rows.map((row) => render(row)),
  ]
  if (result.reaped.length > 0) {
    lines.push(
      `reaped    ${result.reaped.length} expired failed lab(s): ${result.reaped.join(', ')}`,
    )
  }
  return `${lines.join('\n')}\n`
}

function renderLabInspect(result: LabInspectResult): string {
  const m = result.manifest
  const lines = [
    `lab       ${m.id}`,
    `state     ${m.state}`,
    `profile   ${m.source.profileName}`,
    `created   ${m.createdAt}`,
    `source    ${m.source.receipt}`,
    `dsh       ${m.dshVersion} (adapter ${m.adapterId})`,
    `runtime   ${m.runtime.nodeVersion} · ${m.runtime.os} · ${m.runtime.arch}`,
    `runs      ${m.runCount}`,
  ]
  if (m.lockfileHash !== undefined) lines.push(`lockfile  ${m.lockfileHash}`)
  if (m.lastRun !== undefined) {
    lines.push(
      `last run  ${m.lastRun.finishedAt} ${m.lastRun.ok ? 'PASS' : 'FAIL'}` +
        (m.lastRun.port !== undefined ? ` (loopback port ${m.lastRun.port})` : ''),
    )
  }
  if (m.plan.length > 0) {
    lines.push(
      `plan      ${m.plan.map((step) => `${step.action}${step.id !== undefined ? ` ${step.id}` : ''}`).join(' | ')}`,
    )
  }
  if (m.retention.expiresAt !== undefined) {
    lines.push(`retention expires ${m.retention.expiresAt} (failed-lab diagnostics window)`)
  } else {
    lines.push(
      `retention ${m.retention.cleanupMode === 'delete-on-success' ? 'clean up on success (default)' : 'retained by --keep'}`,
    )
  }
  lines.push(`probes    ${result.probes.length} recorded`)
  for (const entry of result.probes) {
    const tag = entry.status.toUpperCase().padEnd(4)
    lines.push(`  [${tag}] ${entry.label}`)
    if (entry.detail !== undefined) lines.push(`         ${redactText(entry.detail)}`)
  }
  return `${lines.join('\n')}\n`
}

function renderLabDestroy(result: LabDestroyResult): string {
  return `lab ${result.id} destroyed (lab dir removed)\n`
}

function renderLabPromote(result: LabPromoteCommandResult): string {
  const gateLabel =
    result.clientGate === 'pass'
      ? 'PASS (browser client probes recorded)'
      : result.clientGate === 'fail'
        ? 'FAIL (client probes refused promotion)'
        : 'inconclusive (accepted with --accept-inconclusive)'
  const lines = [
    `promoted  lab ${result.labId} onto profile ${result.profileName}`,
    `client    ${gateLabel}`,
    `snapshots pre   ${result.preSnapshot}`,
  ]
  if (result.afterSnapshot !== null) lines.push(`          after ${result.afterSnapshot}`)
  if (result.appliedFiles.length > 0) {
    lines.push(`files     ${result.appliedFiles.join(', ')}`)
  }
  lines.push(
    result.restartVerified
      ? `restart   verified — after-snapshot marked lastKnownGood`
      : `restart   skipped (default; --restart re-verifies the official boot)`,
  )
  if (result.lastKnownGood !== null) lines.push(`last-known-good ${result.lastKnownGood}`)
  lines.push(`journal   ${result.journalId}`)
  return `${lines.join('\n')}\n`
}

function renderDoctor(result: DoctorResult): string {
  const lines: string[] = ['doctor:', `  profile: ${result.profileName}`]
  for (const outcome of result.checks) {
    const tag = outcome.status.toUpperCase().padEnd(4)
    lines.push(`  [${tag}] ${outcome.title}`)
    if (outcome.detail !== undefined) {
      lines.push(`         ${redactText(outcome.detail)}`)
    }
  }
  const { ok, failed, warned, info, skipped } = result.summary
  lines.push(
    `summary: ${ok} ok, ${failed} failed, ${warned} warned, ${info} info, ${skipped} skipped`,
  )
  if (failed > 0) lines.push(`verdict: FAIL (${failed} check${failed === 1 ? '' : 's'} failed)`)
  else lines.push('verdict: PASS')
  return `${lines.join('\n')}\n`
}

function renderSnapshotCreate(result: SnapshotCreateResult): string {
  const lines = [
    `snapshot  ${result.id}`,
    `profile   ${result.profileName} (home ${result.home})`,
    `created   ${result.createdAt}`,
    `label     ${result.label ?? '(none)'}`,
    `parent    ${result.parentId ?? '(none)'}`,
    `dsh       ${result.dsh.cliVersion ?? '(undetectable)'}${result.dsh.known ? '' : ' (untested)'}`,
  ]
  for (const record of result.files) {
    const marker = record.secretSkipped ? 'secret-skipped' : record.stored ? 'stored' : 'recorded'
    lines.push(`  ${record.role.padEnd(14)} ${record.name.padEnd(22)} ${marker}`)
  }
  if (result.skippedSecrets.length > 0) {
    lines.push(`skipped    ${result.skippedSecrets.join(', ')} (secret-bearing, not stored)`)
  }
  for (const warning of result.warnings) lines.push(`warning    ${redactText(warning)}`)
  lines.push('snapshot committed to the vault')
  return `${lines.join('\n')}\n`
}

function renderTimelineList(result: TimelineListResult): string {
  if (result.snapshots.length === 0) {
    return (
      `no snapshots for profile ${result.profileName} yet — ` +
      `run \`dsh-world-line snapshot create\`\n`
    )
  }
  const rows = result.snapshots.map((row) => [
    row.id,
    row.createdAt,
    row.label ?? '-',
    `${row.files} files`,
    `${row.dependencies} deps`,
    row.dshCliVersion ?? '-',
  ])
  const widths = [0, 1, 2, 3, 4].map((column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  )
  const header = ['id', 'created', 'label', 'composition', 'plugins', 'dsh']
  const render = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  const lines = [render(header), ...rows.map((row) => render(row))]
  if (result.corrupt.length > 0) {
    lines.push(`corrupt manifests in the vault: ${result.corrupt.length}`)
    for (const entry of result.corrupt) lines.push(`  ${redactText(entry)}`)
  }
  return `${lines.join('\n')}\n`
}

function renderTimelineShow(result: TimelineShowResult): string {
  const m = result.manifest
  const lines = [
    `snapshot  ${m.id}`,
    `created   ${m.createdAt}`,
    `label     ${m.label ?? '(none)'}`,
    `parent    ${m.parentId ?? '(none)'}`,
    `profile   ${m.profile.name}`,
    `dsh       ${m.dsh.cliVersion ?? '(undetectable)'}`,
    `node/os   ${m.createdBy.environment.node} · ${m.createdBy.environment.os} · ${m.createdBy.environment.arch}`,
    `bundles   ${m.profile.manifest.bundles.join(', ') || '(none)'}`,
    `receipt   ${m.profile.receipt.tree}`,
  ]
  for (const record of m.files) {
    const state = record.secretSkipped
      ? 'secret-skipped'
      : record.object === null
        ? 'not stored'
        : 'stored'
    lines.push(
      `  ${record.role.padEnd(14)} ${record.name.padEnd(22)} ${state} ` +
        `${record.sha256.slice(0, 12)} (${record.size} B)`,
    )
    if (record.parseError !== undefined) {
      lines.push(`    parse error: ${redactText(record.parseError)}`)
    }
  }
  if (m.homePatch !== null && m.homePatch.present) {
    lines.push(
      `  home patch  cordis.patch.yml  ${m.homePatch.secretSkipped === true ? 'secret-skipped' : 'stored'}`,
    )
  }
  for (const dependency of m.profile.dependencies) {
    const head = dependency.gitHead != null ? ` @ ${dependency.gitHead.slice(0, 12)}` : ''
    const target = dependency.target !== undefined ? ` -> ${dependency.target}${head}` : ''
    const resolved =
      dependency.resolved?.version !== undefined ? ` = ${dependency.resolved.version}` : ''
    lines.push(
      `  dep  ${dependency.name} (${dependency.kind}) ${dependency.spec}${resolved}${target}`,
    )
  }
  const derived = m.derived.rootConfigPresent
    ? m.derived.rootConfigClean === false
      ? 'dirty (dsh rewrites on boot)'
      : 'clean'
    : 'absent'
  lines.push(`derived   cordis.yml ${derived}`)
  if (m.unmanaged.length > 0) {
    lines.push(`unmanaged ${m.unmanaged.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

function renderTimelineDiff(result: TimelineDiffResult): string {
  const { diff } = result
  const lines = [`diff ${result.fromId} -> ${result.toId}`]
  if (diff.meta.labelChanged || diff.meta.dshChanged || diff.meta.environmentChanged) {
    lines.push('meta changed')
  }
  if (diff.bundles.changed) {
    lines.push(
      `bundles   before: ${diff.bundles.before.join(', ') || '(none)'}`,
      `          after:  ${diff.bundles.after.join(', ') || '(none)'}`,
    )
  }
  for (const record of diff.files) {
    const before = record.before?.sha256.slice(0, 12) ?? '-'
    const after = record.after?.sha256.slice(0, 12) ?? '-'
    lines.push(`file      ${record.status.padEnd(9)} ${record.name} ${before} -> ${after}`)
  }
  for (const dependency of diff.dependencies) {
    if (dependency.status === 'unchanged') continue
    lines.push(
      `dependency ${dependency.status.padEnd(9)} ${dependency.name}` +
        (dependency.changedFields.length > 0 ? ` (${dependency.changedFields.join(', ')})` : ''),
    )
  }
  for (const patch of diff.patches) {
    lines.push(
      `patch     ${patch.status.padEnd(9)} ${patch.file} ${patch.key}${patch.id !== undefined ? ` (id ${patch.id})` : ''}`,
    )
  }
  if (diff.derived.changed) lines.push('derived   cordis.yml state changed')
  for (const name of diff.unmanaged.added) lines.push(`unmanaged added ${name}`)
  for (const name of diff.unmanaged.removed) lines.push(`unmanaged removed ${name}`)
  if (
    diff.files.length === 0 &&
    !diff.bundles.changed &&
    diff.dependencies.every((entry) => entry.status === 'unchanged') &&
    diff.patches.length === 0 &&
    !diff.derived.changed &&
    diff.unmanaged.added.length === 0 &&
    diff.unmanaged.removed.length === 0
  ) {
    lines.push('no semantic differences')
  }
  return `${lines.join('\n')}\n`
}

/** Run the CLI; returns the exit code without touching process.exit. */
export async function runCli(
  argv: readonly string[],
  io?: {
    out?: (text: string) => void
    err?: (text: string) => void
    cwd?: string
    env?: NodeJS.ProcessEnv
    now?: () => Date
  },
): Promise<number> {
  const out = io?.out ?? ((text: string) => process.stdout.write(text))
  const err = io?.err ?? ((text: string) => process.stderr.write(text))
  const cwd = io?.cwd ?? process.cwd()
  const env = io?.env ?? process.env

  if (argv.length === 0) {
    err(HELP)
    return 2
  }
  if (argv.includes('-h') || argv.includes('--help') || argv[0] === 'help') {
    out(HELP)
    return 0
  }
  if (argv.includes('-V') || argv.includes('--version')) {
    out(`${WORLD_LINE_VERSION}\n`)
    return 0
  }

  let invocation: Invocation
  try {
    invocation = parseInvocation(argv, { cwd, env, now: io?.now })
  } catch (error) {
    return reportError({ out, err }, 'unknown', error)
  }

  const { context, command, args } = invocation
  try {
    const result = await dispatch(context, command, args)
    if (context.json) {
      out(
        `${JSON.stringify(
          {
            schemaVersion: ENVELOPE_SCHEMA_VERSION,
            command: result.command,
            ok: true,
            data: result.data,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      const rendered = renderHuman(result.command, result.data)
      if (rendered !== '') out(rendered)
    }
    // Verification semantics: doctor and lab verbs exit 1 on failure.
    if (command === 'doctor') {
      const doctorData = result.data as DoctorResult
      return doctorData.summary.failed > 0 ? 1 : 0
    }
    if (
      (result.command === 'lab add' ||
        result.command === 'lab update' ||
        result.command === 'lab remove' ||
        result.command === 'lab config apply') &&
      (result.data as LabActionResult).ok === false
    ) {
      return 1
    }
    return 0
  } catch (error) {
    return reportError({ out, err }, command, error, context.json)
  }
}

/** Render one error through the envelope or stderr; returns its exit code. */
function reportError(
  output: { out: (text: string) => void; err: (text: string) => void },
  command: string,
  error: unknown,
  json = false,
): number {
  const wlError = error instanceof WlError ? error : null
  const message = redactText(error instanceof Error ? error.message : String(error))
  const exitCode = wlError?.exitCode ?? 3
  if (json) {
    output.out(
      `${JSON.stringify(
        {
          schemaVersion: ENVELOPE_SCHEMA_VERSION,
          command,
          ok: false,
          error: {
            code: wlError?.code ?? 'E_INTERNAL',
            message,
            exitCode,
          },
        },
        null,
        2,
      )}\n`,
    )
  } else if (wlError === null) {
    output.err(`internal error: ${message}\n`)
    output.err(`this is a world-line bug — please report it with the command that failed\n`)
  } else {
    output.err(`${command !== '' ? `${command}: ` : ''}${message}\n`)
  }
  return exitCode
}

/** The bin entry: run with the real process environment. */
export async function main(argv: readonly string[]): Promise<number> {
  return runCli(argv)
}
