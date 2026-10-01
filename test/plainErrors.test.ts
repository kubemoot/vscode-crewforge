import { describe, expect, it } from 'vitest';
import { errorCode, plainCredentialsMessage, plainNetworkMessage, plainStatusMessage } from '../src/k8s/plainErrors';
import { connectionError } from '../src/k8s/request';

const where = { context: 'docker-desktop', server: 'https://127.0.0.1:49681' };

describe('plain words for a cluster that cannot be reached', () => {
  it('names the context and server for each network failure', () => {
    expect(plainNetworkMessage('ECONNREFUSED', where)).toBe('No response from context docker-desktop at https://127.0.0.1:49681. Is the cluster running?');
    for (const code of ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) expect(plainNetworkMessage(code, where)).toMatch(/^No answer in time from context docker-desktop at https:\/\/127\.0\.0\.1:49681\. Is the cluster running/);
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) expect(plainNetworkMessage(code, where)).toMatch(/^Cannot find the server of context docker-desktop at .*host name does not resolve/);
    expect(plainNetworkMessage('ECONNRESET', where)).toMatch(/^The connection to context docker-desktop at .* was cut/);
    for (const code of ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(plainNetworkMessage(code, where), code).toMatch(/presented a certificate this kubeconfig does not trust/);
    }
  });

  it('leaves unknown or missing codes to the caller, and names a context without a server', () => {
    expect(plainNetworkMessage('EWHATEVER', where)).toBeUndefined();
    expect(plainNetworkMessage(undefined, where)).toBeUndefined();
    expect(plainNetworkMessage('ECONNREFUSED', { context: 'lab' })).toBe('No response from context lab. Is the cluster running?');
  });

  it('says what a 401 or 403 means, and leaves other statuses alone', () => {
    expect(plainStatusMessage(401, where)).toMatch(/^Context docker-desktop did not accept your credentials/);
    expect(plainStatusMessage(403, where)).toBe('Your account in context docker-desktop is not allowed to do this.');
    expect(plainStatusMessage(403, where, 'crews is forbidden')).toBe('Your account in context docker-desktop is not allowed to do this. The cluster says: crews is forbidden');
    expect(plainStatusMessage(404, where)).toBeUndefined();
    expect(plainCredentialsMessage(where)).toMatch(/^CrewForge could not get credentials for context docker-desktop at https/);
  });

  it('reads the code of an error, if it has one', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('ECONNREFUSED');
    expect(errorCode(Object.assign(new Error('x'), { code: 42 }))).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });

  it('keeps the raw error as the detail, with its code when the message lacks it', () => {
    const refused = connectionError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:49681'), { code: 'ECONNREFUSED' }), where);
    expect(refused.message).toBe('No response from context docker-desktop at https://127.0.0.1:49681. Is the cluster running?');
    expect(refused.detail).toBe('connect ECONNREFUSED 127.0.0.1:49681');
    const cert = connectionError(Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), where);
    expect(cert.detail).toBe('CERT_HAS_EXPIRED: certificate has expired');
    const odd = connectionError(new Error('socket hang up'), { context: 'lab' });
    expect(odd.message).toBe('Could not reach context lab: socket hang up');
    expect(connectionError(new Error('boom'), where).message).toBe('Could not reach context docker-desktop at https://127.0.0.1:49681: boom');
  });
});
