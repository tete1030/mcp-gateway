import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { isCanonicalDnsHostname } from './callback-host-policy.mjs';

export const CALLBACK_ERROR_CATEGORIES = Object.freeze(['dns_not_found', 'dns_failure', 'dns_timeout',
  'connection_refused', 'connection_reset', 'network_unreachable', 'tls_error', 'timeout', 'aborted',
  'address_rejected', 'host_not_allowed', 'response_too_large', 'response_error', 'invalid_http_response', 'transport_error',
  'challenge_http_error', 'challenge_invalid_json', 'challenge_missing_value', 'challenge_mismatch']);
const categories = new Set(CALLBACK_ERROR_CATEGORIES);
export class CallbackTransportError extends Error {
  constructor(category) {
    const safe = categories.has(category) ? category : 'transport_error';
    super(safe === 'address_rejected' ? 'Callback address rejected' : `Callback transport: ${safe}`);
    this.name = 'CallbackTransportError'; this.category = safe;
  }
}
export function callbackErrorCategory(error) {
  if (error instanceof CallbackTransportError && categories.has(error.category)) return error.category;
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') return 'timeout';
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'aborted';
  if (error?.code === 'ENOTFOUND') return 'dns_not_found';
  if (error?.code === 'EAI_AGAIN') return 'dns_failure';
  if (error?.code === 'ECONNREFUSED') return 'connection_refused';
  if (['ECONNRESET', 'EPIPE'].includes(error?.code)) return 'connection_reset';
  if (['ENETUNREACH', 'EHOSTUNREACH'].includes(error?.code)) return 'network_unreachable';
  if (['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_SSL_WRONG_VERSION_NUMBER'].includes(error?.code)) return 'tls_error';
  if (['HPE_INVALID_CONSTANT', 'HPE_INVALID_HEADER_TOKEN', 'HPE_INVALID_CHUNK_SIZE'].includes(error?.code)) return 'invalid_http_response';
  return 'transport_error';
}

export function callbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      /^https:\/\/[^/?#]*@/i.test(value) || value.includes('\\')) {
    throw new Error('Callback must be HTTPS on port 443 without credentials or fragment');
  }
  return url;
}

export function publicAddress(value) {
  try { return ipaddr.parse(value).range() === 'unicast'; } catch { return false; }
}

export function createCallbackTransport({ lookup = dnsLookup, request = httpsRequest, policy = { mode: 'public_addresses' } } = {}) {
  if (!['public_addresses', 'exact_host_allowlist'].includes(policy.mode)) throw new Error('Invalid callback policy');
  if (policy.mode === 'exact_host_allowlist' && (!Array.isArray(policy.allowedHosts) || policy.allowedHosts.length > 8 ||
      policy.allowedHosts.some(host => !isCanonicalDnsHostname(host)))) throw new Error('Invalid callback host configuration');
  const trustedHosts = new Set(policy.allowedHosts ?? []);
  return async (value, { body, headers, signal: parentSignal }) => {
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    signal.throwIfAborted();
    const url = callbackUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let socketLookup;
    if (policy.mode === 'exact_host_allowlist') {
      if (!trustedHosts.has(hostname)) throw new CallbackTransportError('host_not_allowed');
      // Explicitly approved single-owner policy: exact trusted hostname, normal
      // HTTPS/TLS and the existing network route. No separate DNS/IP precheck.
    } else {
      let records;
      if (ipaddr.isValid(hostname)) records = [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }];
      else {
        let timer;
        try {
          records = await Promise.race([
            lookup(hostname, { all: true, verbatim: true }),
            new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new CallbackTransportError('dns_timeout')), 5000); }),
          ]);
        } catch (error) {
          throw new CallbackTransportError(callbackErrorCategory(error));
        } finally { clearTimeout(timer); }
      }
      if (!records.length || records.length > 16 || records.some(r => !publicAddress(r.address))) {
        throw new CallbackTransportError('address_rejected');
      }
      const chosen = records[0];
      socketLookup = (_name, options, done) => options?.all
        ? done(null, [chosen]) : done(null, chosen.address, chosen.family);
    }
    signal.throwIfAborted();
    // Generic mode pins validated IPs. Exact-host mode uses the normal network
    // route; both preserve the original Host and certificate verification.
    return new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'POST', agent: false,
        headers: { ...headers, Host: url.host, 'Content-Length': Buffer.byteLength(body) },
        ...(socketLookup ? { lookup: socketLookup } : { servername: hostname }),
        rejectUnauthorized: true,
        timeout: 5000,
        signal,
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 32 * 1024) { res.destroy(); reject(new CallbackTransportError('response_too_large')); }
          else chunks.push(chunk);
        });
        res.on('error', () => reject(new CallbackTransportError('response_error')));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), retryAfter: res.headers?.['retry-after'] }));
      });
      req.on('timeout', () => req.destroy(new CallbackTransportError('timeout')));
      req.on('error', error => reject(new CallbackTransportError(callbackErrorCategory(error))));
      req.end(body);
    });
  };
}
