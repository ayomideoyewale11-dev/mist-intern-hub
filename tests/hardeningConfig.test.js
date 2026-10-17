const { validNewPassword, passwordFitsBcrypt, MAX_BCRYPT_PASSWORD_BYTES } = require('../config/validate');
const { parsePage, MAX_PAGE, listParams } = require('../config/listing');

describe('password byte limits', () => {
  it('accepts a password that fits the bcrypt limit and rejects one that exceeds it', () => {
    expect(passwordFitsBcrypt('x'.repeat(MAX_BCRYPT_PASSWORD_BYTES))).toBe(true);
    expect(passwordFitsBcrypt('x'.repeat(MAX_BCRYPT_PASSWORD_BYTES + 1))).toBe(false);
    expect(validNewPassword('x'.repeat(8))).toBe(true);
    expect(validNewPassword('😀'.repeat(19))).toBe(false); // 76 UTF-8 bytes
  });
});

describe('page bounds', () => {
  it('defaults invalid pages to the first page and caps very large page numbers', () => {
    expect(parsePage('0')).toBe(1);
    expect(parsePage('-4')).toBe(1);
    expect(parsePage('1.5')).toBe(1);
    expect(parsePage('not-a-page')).toBe(1);
    expect(parsePage(String(MAX_PAGE + 1))).toBe(MAX_PAGE);
  });

  it('applies the same bound when building list parameters', () => {
    expect(listParams({ query: { page: String(MAX_PAGE * 100) } }).page).toBe(MAX_PAGE);
  });
});
