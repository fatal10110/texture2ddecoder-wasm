#!/usr/bin/env node

/**
 * Helper script to copy WASM files to your project's public directory
 * Usage: node node_modules/texture2ddecoder-wasm/scripts/copy-wasm.js [destination]
 * 
 * Examples:
 *   node node_modules/texture2ddecoder-wasm/scripts/copy-wasm.js public/wasm
 *   node node_modules/texture2ddecoder-wasm/scripts/copy-wasm.js static/wasm
 *   npx texture2ddecoder-wasm-copy public/wasm
 */

const fs = require('fs');
const path = require('path');

// Get destination from command line or use default
const args = process.argv.slice(2);
const destination = args[0] || 'public/wasm';

// Resolve paths
const sourceDir = path.join(__dirname, '..', 'wasm');
const destDir = path.resolve(process.cwd(), destination);

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function copyDirectory(src, dest) {
  // Create destination directory if it doesn't exist
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
    log(`✓ Created directory: ${dest}`, 'green');
  }

  // Read source directory
  const files = fs.readdirSync(src);
  let copiedCount = 0;

  files.forEach(file => {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);

    // Copy file
    fs.copyFileSync(srcPath, destPath);
    copiedCount++;
    log(`  ✓ Copied: ${file}`, 'blue');
  });

  return copiedCount;
}

function main() {
  log('\n📦 texture2ddecoder-wasm - WASM File Copy Utility\n', 'yellow');

  // Check if source directory exists
  if (!fs.existsSync(sourceDir)) {
    log('❌ Error: Source WASM directory not found!', 'red');
    log(`   Expected: ${sourceDir}`, 'red');
    log('\n   Make sure texture2ddecoder-wasm is installed:', 'yellow');
    log('   npm install texture2ddecoder-wasm\n', 'yellow');
    process.exit(1);
  }

  try {
    log(`Source:      ${sourceDir}`, 'blue');
    log(`Destination: ${destDir}\n`, 'blue');

    const count = copyDirectory(sourceDir, destDir);

    log(`\n✅ Success! Copied ${count} file(s) to ${destination}\n`, 'green');
    
    log('Next steps:', 'yellow');
    log('1. Initialize in your code:', 'blue');
    log(`   await initialize('/${path.basename(destination)}');\n`, 'blue');
    
    log('2. Add to .gitignore (optional):', 'blue');
    log(`   echo "${destination}/" >> .gitignore\n`, 'blue');

  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    process.exit(1);
  }
}

main();

