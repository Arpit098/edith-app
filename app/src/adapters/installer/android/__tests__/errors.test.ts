import { ApiError, isRetryable } from '../../../../core/api';
import { asApiError } from '..';

function coded(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe('asApiError', () => {
  it('maps the native error codes onto the HTTP retry rule', () => {
    expect(asApiError(coded('NETWORK', 'timeout'))).toEqual(new ApiError(0, 'timeout'));
    expect(asApiError(coded('HTTP_503', 'Download failed (HTTP 503)'))).toMatchObject({ status: 503 });
    expect(isRetryable(asApiError(coded('NETWORK', 'reset')))).toBe(true);
    expect(isRetryable(asApiError(coded('HTTP_502', 'x')))).toBe(true);
    expect(isRetryable(asApiError(coded('HTTP_404', 'x')))).toBe(false);
  });

  it('leaves other failures alone (never retried)', () => {
    const mismatch = coded('SHA256_MISMATCH', 'deleted');
    expect(asApiError(mismatch)).toBe(mismatch);
    expect(isRetryable(asApiError(mismatch))).toBe(false);
    expect(asApiError('weird')).toBe('weird');
  });
});
