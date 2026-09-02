// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { TwoFactorChallenge } from '@/app/(auth)/sign-in/_components/TwoFactorChallenge';

afterEach(() => cleanup());

describe('the remembered-device checkbox', () => {
  it('announces checked state instead of role-editor membership state', () => {
    renderWithIntl(
      <TwoFactorChallenge
        email="ada@example.com"
        callbackURL="/items"
        methods={['totp']}
        trustDeviceDays={30}
        otpPeriodMinutes={10}
      />,
    );

    expect(
      screen.getByRole('checkbox', {
        name: 'Don’t ask again on this device for 30 days, Not checked',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Held|Not held/ })).toBeNull();
  });
});
