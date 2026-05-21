#!/usr/bin/env node
// Archon CLI — command surface for the MVP scaffold. Each command is a stub
// whose implementation is tracked in docs/ROADMAP.md.

const HELP = `archon — constrained AI staff-engineer runtime (MVP scaffold)

Usage:
  archon index            Incrementally index changed files            (M1)
  archon plan <goal>      Produce a plan tree — no writes               (M6)
  archon run <goal>       Plan -> act -> verify under the safe profile  (M6)
  archon status           Show task journal + budget                    (M0)
  archon --help           Show this help

All commands are scaffold stubs. See docs/ROADMAP.md and AGENTS.md.`;

function todo(cmd: string, milestone: string): void {
  console.log(`[archon] "${cmd}" is a scaffold stub — implementation tracked in docs/ROADMAP.md (${milestone}).`);
  process.exitCode = 2;
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      console.log(HELP);
      return;
    case 'index':
      todo('index', 'M1');
      return;
    case 'plan':
      todo(`plan ${rest.join(' ')}`.trim(), 'M6');
      return;
    case 'run':
      todo(`run ${rest.join(' ')}`.trim(), 'M6');
      return;
    case 'status':
      todo('status', 'M0');
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2));
