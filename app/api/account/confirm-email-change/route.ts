import { NextResponse } from 'next/server';
import { usersService } from '@/lib/services/usersService';
import { EmailTakenError, InvalidEmailChangeTokenError } from '@/lib/users/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';

// GET /api/account/confirm-email-change?token=… (Subtask 8.8.22) — step 2 of a
// verified email change: the user clicked the link emailed to their NEW address.
// The token is the capability, so this is intentionally UNAUTHENTICATED (the
// click may land in any browser, signed-in or not) — exactly like the
// password-reset confirm link. We consume the single-use token, swap the email,
// and redirect back to the account-settings page with a status query the UI
// renders as a banner.
//
// Routes are HTTP-only (CLAUDE.md): one service call, then translate the outcome
// to a redirect. The service owns the transaction + the typed errors.

const SETTINGS_PATH = '/settings/account';

function redirectTo(status: string): Response {
  const url = `${resolveBaseUrlTrimmed()}${SETTINGS_PATH}?emailChange=${status}`;
  return NextResponse.redirect(url);
}

export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return redirectTo('invalid');

  try {
    await usersService.confirmEmailChange(token);
    return redirectTo('confirmed');
  } catch (err) {
    if (err instanceof InvalidEmailChangeTokenError) return redirectTo('invalid');
    if (err instanceof EmailTakenError) return redirectTo('taken');
    throw err;
  }
}
