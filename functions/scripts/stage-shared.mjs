import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootSharedDir = path.resolve(__dirname, '../../shared');
const targetStagedDir = path.resolve(__dirname, '../staged-shared');

const sharedDist = path.join(rootSharedDir, 'dist');
if (!fs.existsSync(path.join(sharedDist, 'index.js')) || !fs.existsSync(path.join(sharedDist, 'commands.js'))) {
  throw new Error('Build the shared package before staging Functions.');
}
fs.mkdirSync(targetStagedDir, { recursive: true });
fs.copyFileSync(path.join(rootSharedDir, 'package.json'), path.join(targetStagedDir, 'package.json'));
const targetDist = path.join(targetStagedDir, 'dist');
fs.rmSync(targetDist, { recursive: true, force: true });
fs.cpSync(sharedDist, targetDist, { recursive: true });
