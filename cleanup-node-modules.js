const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Cleaning up node_modules...');

// Remove node_modules directory
const nodeModulesPath = path.join(__dirname, 'node_modules');
if (fs.existsSync(nodeModulesPath)) {
    console.log('Removing node_modules directory...');
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
}

// Remove package-lock.json
const packageLockPath = path.join(__dirname, 'package-lock.json');
if (fs.existsSync(packageLockPath)) {
    console.log('Removing package-lock.json...');
    fs.unlinkSync(packageLockPath);
}

// Clean npm cache
console.log('Cleaning npm cache...');
execSync('npm cache clean --force', { stdio: 'inherit' });

// Reinstall dependencies
console.log('\nReinstalling dependencies...');
execSync('npm install', { stdio: 'inherit' });

console.log('\nCleanup complete!'); 