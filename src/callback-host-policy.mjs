import ipaddr from 'ipaddr.js';

// Configuration accepts exact canonical DNS names, never URLs or wildcards.
export function isCanonicalDnsHostname(value) {
  return typeof value === 'string' && value.length <= 253 && !ipaddr.isValid(value) &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}
