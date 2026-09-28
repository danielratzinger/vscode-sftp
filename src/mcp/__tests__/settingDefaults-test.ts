import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PORT } from '../leader';

/**
 * The fallback in `settings().get(key, fallback)` is only reached when a setting
 * is undeclared. Every one of these is declared, so the fallback beside the call
 * never runs - and if the two disagree, the one in the code is a comment that
 * reads like behaviour. `mcp.callTimeout` drifted exactly that way: 45s in the
 * code, 120s in force, and a client that had stopped waiting long before an
 * answer arrived.
 */

const root = path.resolve(__dirname, '../../..');
const declared = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
).contributes.configuration.properties;
const source = fs.readFileSync(path.join(root, 'src/mcp/index.ts'), 'utf8');

const constant = (name: string): number => {
  const found = new RegExp(`const ${name} = (\\d+)`).exec(source);
  expect(found).toBeTruthy();
  return Number(found![1]);
};

it('declares the same default the code falls back to', () => {
  expect(declared['sftp.mcp.callTimeout'].default).toBe(constant('DEFAULT_CALL_TIMEOUT'));
  expect(declared['sftp.mcp.port'].default).toBe(DEFAULT_PORT);
});

it('keeps a call inside what a client will wait for', () => {
  // Claude Desktop and the others give up on a tool call in about a minute. A
  // ceiling above that turns every cut-short answer into a timeout at the
  // client, which is the one outcome the budget exists to avoid.
  expect(declared['sftp.mcp.callTimeout'].default).toBeLessThanOrEqual(60000);
});
