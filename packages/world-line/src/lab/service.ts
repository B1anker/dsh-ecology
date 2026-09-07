import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { FileError, UsageError } from '../domain/errors.js'
import { labDir } from './layout.js'

/** Private runtime record, excluded from manifests/reports: contains a local control credential. */
export interface ServiceRecord {
  id: string
  hostname: string
  pid: number
  controlPort: number
  controlToken: string
  port: number
  state: 'running' | 'stopped'
}

export function servicePath(home: string, id: string): string {
  return join(labDir(home, id), 'service.json')
}

export async function readService(home: string, id: string): Promise<ServiceRecord | null> {
  try {
    const record = JSON.parse(await readFile(servicePath(home, id), 'utf8')) as ServiceRecord
    if (
      record.id !== id ||
      !Number.isInteger(record.controlPort) ||
      record.controlPort < 1 ||
      record.controlPort > 65535 ||
      !/^[a-f0-9]{64}$/.test(record.controlToken)
    ) {
      throw new FileError(`invalid runtime record for ${id}`)
    }
    return record
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new FileError(`cannot read runtime record for ${id}`)
  }
}

async function requestService(
  record: ServiceRecord,
  stop = false,
): Promise<{ id: string; url?: string } | null> {
  if (record.hostname !== hostname()) throw new UsageError('this lab belongs to another machine')
  try {
    const response = await fetch(
      `http://127.0.0.1:${record.controlPort}/${stop ? 'stop' : 'status'}`,
      {
        method: stop ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${record.controlToken}` },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      },
    )
    if (!response.ok) throw new UsageError('lab control endpoint refused the request')
    const body = (await response.json()) as { id: string; url?: string }
    if (body.id !== record.id) throw new UsageError('lab control identity mismatch')
    return body
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') return null
    throw error
  }
}

export async function controlService(record: ServiceRecord, stop = false): Promise<boolean> {
  return (await requestService(record, stop)) !== null
}

export async function serviceStatus(
  record: ServiceRecord,
): Promise<{ id: string; url?: string } | null> {
  return await requestService(record)
}
