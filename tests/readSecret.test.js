const { PassThrough } = require('node:stream');
const readSecret = require('../scripts/readSecret');

describe('admin password prompt', () => {
  it('reads a secret without echoing entered characters', async () => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = jest.fn();
    const output = { write: jest.fn() };

    const pending = readSecret(input, output);
    input.emit('data', 'sensitive-password\r');

    await expect(pending).resolves.toBe('sensitive-password');
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(output.write.mock.calls.flat().join('')).not.toContain('sensitive-password');
  });

  it('supports non-interactive password input through standard input', async () => {
    const input = new PassThrough();
    const output = { write: jest.fn() };
    const pending = readSecret(input, output);
    input.end('stdin-password\n');
    await expect(pending).resolves.toBe('stdin-password');
  });
});
