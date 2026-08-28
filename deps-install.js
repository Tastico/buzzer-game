/**
 * Buzzer Game — Dependency Installer
 * 
 * Verifies that node_modules contains all required dependencies.
 * If missing or incomplete, attempts to fix by:
 *   1. Checking if bundled node_modules exists (pre-extracted)
 *   2. Running npm install as fallback
 * 
 * Run: node deps-install.js
 */

const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.join(__dirname, 'node_modules');
const PKG_FILE = path.join(__dirname, 'package.json');

const C = { reset: '\x1b[0m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', bold: '\x1b[1m' };
function ok(m) { console.log(`${C.green}[OK]${C.reset} ${m}`); }
function warn(m) { console.log(`${C.yellow}[!]${C.reset} ${m}`); }
function fail(m) { console.log(`${C.red}[FAIL]${C.reset} ${m}`); }

const CORE_DEPS = ['express', 'ws', 'uuid'];

function allInstalled() {
  return CORE_DEPS.every(d => fs.existsSync(path.join(NODE_MODULES, d, 'package.json')));
}

function main() {
  console.log(`${C.cyan}${C.bold}`);
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║    BUZZER GAME — DEP INSTALLER      ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`${C.reset}`);

  ok(`Node.js ${process.version}`);

  // Step 1: Check if everything is already installed
  if (allInstalled()) {
    ok(`All dependencies ready!`);
    process.exit(0);
  }

  // Step 2: Check node_modules exists
  if (fs.existsSync(NODE_MODULES)) {
    const exists = fs.readdirSync(NODE_MODULES).filter(f => !f.startsWith('.'));
    warn(`node_modules/ found (${exists.length} packages) but some core deps are missing.`);
    warn(`Missing: ${CORE_DEPS.filter(d => !fs.existsSync(path.join(NODE_MODULES, d, 'package.json'))).join(', ')}`);
  }

  // Step 3: Try npm install
  warn(`Trying npm install...`);
  try {
    const { execSync } = require('child_process');
    execSync('npm install --no-audit --no-fund', { cwd: __dirname, stdio: 'inherit' });
  } catch(e) {
    fail(`npm install failed.`);
    fail(`This folder may be incomplete or corrupted.`);
    fail(`Please re-download the game zip or run manually:`);
    fail(`  cd "${__dirname}"`);
    fail(`  npm install`);
    process.exit(1);
  }

  // Step 4: Verify
  if (allInstalled()) {
    ok(`Dependencies installed successfully!`);
    process.exit(0);
  } else {
    const missing = CORE_DEPS.filter(d => !fs.existsSync(path.join(NODE_MODULES, d, 'package.json')));
    fail(`npm install finished but some deps are still missing: ${missing.join(', ')}`);
    fail(`Try deleting node_modules/ and running start.bat again.`);
    process.exit(1);
  }
}

main();
