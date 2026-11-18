import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/modules/auth/auth.service';

describe('masking the delivery address', () => {
  it('keeps enough for the owner to recognise it', () => {
    expect(AuthService.maskEmail('sundayfavour997@gmail.com')).toBe('s•••@g•••.com');
  });

  it('keeps multi-part domains intact after the first label', () => {
    expect(AuthService.maskEmail('ada@mail.co.uk')).toBe('a•••@m•••.co.uk');
  });

  it('never returns the original address', () => {
    for (const email of ['a@b.com', 'verylongaddress@example.org']) {
      expect(AuthService.maskEmail(email)).not.toBe(email);
    }
  });

  it('does not throw on malformed input', () => {
    expect(AuthService.maskEmail('not-an-email')).toBe('•••');
  });
});
