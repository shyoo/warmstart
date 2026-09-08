import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * The daemon's one promise-based `execFile` runner.
 *
 * Call sites keep their own timeout, environment and `maxBuffer`: those are properties of the
 * command being run, while the conversion from Node's callback API is not.
 */
export const run = promisify(execFile)
