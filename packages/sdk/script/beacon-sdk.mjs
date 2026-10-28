// beacon-sdk for Node scripts: import { emit, notify, progress } from './beacon-sdk.mjs'
const PREFIX = '@@beacon '
const send = (m) => process.stdout.write(PREFIX + JSON.stringify(m) + '\n')
export const emit = (item) => process.stdout.write(JSON.stringify(item) + '\n')
export const notify = (title, body) => send({ type: 'notify', title, ...(body ? { body } : {}) })
export const progress = (value, label) =>
  send({ type: 'progress', value, ...(label ? { label } : {}) })
