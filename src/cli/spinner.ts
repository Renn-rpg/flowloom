import ora, { type Ora } from 'ora'

export function createSpinner(text: string): Ora {
  return ora({ text, stream: process.stderr, spinner: 'dots' }).start()
}

export function toolIcon(name: string): string {
  switch (name) {
    case 'read_file':
      return '📖'
    case 'write_file':
      return '✏️'
    case 'edit_file':
      return '🔧'
    case 'run_shell':
      return '⚡'
    default:
      return '🔨'
  }
}

export function toolStart(name: string, detail?: string): Ora {
  const icon = toolIcon(name)
  const msg = detail ? `${icon} ${name} ${detail}` : `${icon} ${name}`
  return createSpinner(msg)
}
