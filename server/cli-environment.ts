import path from 'node:path';
import os from 'node:os';

// Finder-launched apps inherit a minimal PATH. Use the same search path for
// detecting a CLI and for launching it (including its /usr/bin/env node wrapper).
export function cliEnvironment(executable?:string):NodeJS.ProcessEnv{
  const directories=[process.env.PATH,executable?path.dirname(executable):undefined,
    '/opt/homebrew/bin','/usr/local/bin',path.join(os.homedir(),'.opencode/bin'),
    path.join(os.homedir(),'.local/bin'),path.join(os.homedir(),'.grok/bin'),!process.versions.electron?path.dirname(process.execPath):undefined];
  return{...process.env,PATH:[...new Set(directories.filter((entry):entry is string=>!!entry).flatMap(entry=>entry.split(path.delimiter)))].join(path.delimiter)};
}
